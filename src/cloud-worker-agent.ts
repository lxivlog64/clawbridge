import { CodeBuddyClient } from "./codebuddy-client.js";
import { CloudControlClient } from "./cloud-control-client.js";
import type { CloudTask } from "./cloud-task-store.js";
import { mapRemoteState } from "./lifecycle.js";
import type { ProjectRegistry } from "./project-registry.js";
import { LocalWorker } from "./remote-worker.js";
import { prepareWorktree, type GitPreparerRemote } from "./worktree-preparer.js";

type CloudControlGateway = Pick<CloudControlClient, "heartbeat" | "claim" | "update"> & Partial<Pick<CloudControlClient, "workerTask">>;
type CodeBuddyGateway = Pick<CodeBuddyClient, "dispatchJob" | "getJob"> & Partial<Pick<CodeBuddyClient, "stop">>;
interface LocalExecutionWorker extends GitPreparerRemote {
  gh(worker: Parameters<LocalWorker["gh"]>[0], cwd: string, args: string[]): ReturnType<LocalWorker["gh"]>;
}
/** Persisted coordinates of an accepted remote job, retained even when its final outcome is unknown. */
type JobDetails = { remoteJobId: string; worktreePath: string; baseSha: string; branch: string };

export interface CloudWorkerAgentOptions {
  workerId: string;
  projects: ProjectRegistry;
  control: CloudControlGateway;
  codeBuddy: CodeBuddyGateway;
  pollMs?: number;
  localWorker?: LocalExecutionWorker;
}

/** Runs on the private Worker host. It never exposes CodeBuddy or GitHub credentials to the VPS. */
export class CloudWorkerAgent {
  private readonly pollMs: number;
  private readonly localWorker: LocalExecutionWorker;

  constructor(private readonly options: CloudWorkerAgentOptions) {
    this.pollMs = options.pollMs ?? 10_000;
    this.localWorker = options.localWorker ?? new LocalWorker();
  }

  async once(): Promise<boolean> {
    await this.options.control.heartbeat(this.options.workerId, { version: "0.1.0", runtime: "node" });
    const claimed = await this.options.control.claim(this.options.workerId);
    if (!claimed.task) return false;
    await this.execute(claimed.task);
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.once(); } catch { /* The next poll performs a fresh authenticated heartbeat. */ }
      await wait(this.pollMs, signal);
    }
  }

  private async execute(task: CloudTask): Promise<void> {
    // Set once CodeBuddy accepts the job. From that point on a local error is
    // ambiguous: the remote job may still be running, so it must not be
    // reported as a terminal failure or silently retried.
    let accepted: JobDetails | undefined;
    try {
      const project = this.options.projects.require(task.projectId);
      if (project.workerId !== this.options.workerId) throw new Error("Task is assigned to a different worker.");
      const preflight = this.options.projects.preflight(project.id);
      if (!preflight.ready) throw new Error(preflight.blockers.join(" "));
      const worker = this.options.projects.workerFor(project.id);
      const prepared = await prepareWorktree(task.taskId, project, worker, this.localWorker, (candidate) => this.options.projects.allowsPath(project.id, candidate));
      if (!prepared.ok) throw new Error(prepared.reason);
      if (await this.cancelRequested(task.taskId)) {
        await this.options.control.update(task.taskId, "cancelled", { cancellation: "cancelled before CodeBuddy dispatch" });
        return;
      }
      const job = await this.options.codeBuddy.dispatchJob({
        cwd: prepared.worktreePath,
        prompt: developmentPrompt(task, prepared.baseSha, prepared.branch),
        model: task.requestedModel,
        permissionMode: permissionMode(project.permissionProfile),
        allowedTools: project.allowedTools,
        name: `clawbridge-${task.taskId}`,
        bgIsolation: "none",
      });
      if (!job.id) throw new Error("CodeBuddy gateway returned no job id.");
      accepted = { remoteJobId: job.id, worktreePath: prepared.worktreePath, baseSha: prepared.baseSha, branch: prepared.branch };
      await this.options.control.update(task.taskId, "running", accepted);
      await this.awaitCompletion(task.taskId, task.projectId, accepted);
    } catch (error) {
      // Before a remote job id exists nothing was dispatched, so the attempt is
      // safely failed. Afterwards the remote job may still be running, so the
      // outcome is unknown and must be reconciled by an operator, not retried here.
      if (accepted) await this.options.control.update(task.taskId, "unknown", { ...accepted, error: message(error) });
      else await this.options.control.update(task.taskId, "failed", { error: message(error) });
    }
  }

  private async awaitCompletion(taskId: string, projectId: string, details: JobDetails): Promise<void> {
    while (true) {
      if (await this.cancelRequested(taskId)) {
        if (!this.options.codeBuddy.stop) throw new Error("CodeBuddy gateway does not support job cancellation.");
        await this.options.codeBuddy.stop(details.remoteJobId);
        await this.options.control.update(taskId, "cancelled", { ...details, cancellation: "CodeBuddy stop requested by client" });
        return;
      }
      const job = await this.options.codeBuddy.getJob(details.remoteJobId);
      const state = mapRemoteState(job.state, job.status, job.alive, job.settled);
      if (state === "running") {
        await this.options.control.update(taskId, "running", details);
        await wait(this.pollMs);
        continue;
      }
      if (state !== "succeeded") {
        await this.options.control.update(taskId, state === "failed" || state === "cancelled" ? state : "unknown", { ...details, remoteState: state });
        return;
      }
      const delivery = await this.deliver(taskId, projectId, details);
      await this.options.control.update(taskId, "succeeded", { ...details, ...delivery });
      return;
    }
  }

  private async cancelRequested(taskId: string): Promise<boolean> {
    return this.options.control.workerTask
      ? (await this.options.control.workerTask(this.options.workerId, taskId))?.state === "cancel_requested"
      : false;
  }

  private async deliver(taskId: string, projectId: string, details: { worktreePath: string; baseSha: string; branch: string }): Promise<{ headSha: string; prUrl: string }> {
    const project = this.options.projects.require(projectId);
    const worker = this.options.projects.workerFor(project.id);
    const head = await this.localWorker.git(worker, details.worktreePath, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) throw new Error("Cannot verify task commit.");
    const currentBranch = await this.localWorker.git(worker, details.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== details.branch || details.branch === project.defaultBranch) throw new Error("Task worktree is not on its recorded delivery branch.");
    const pushed = await this.localWorker.git(worker, details.worktreePath, ["push", "--set-upstream", project.deliveryRemote, details.branch]);
    if (pushed.exitCode !== 0) throw new Error(`Could not push task branch: ${pushed.stderr.slice(-1_000)}`);
    const remoteHead = await this.localWorker.git(worker, details.worktreePath, ["ls-remote", project.deliveryRemote, `refs/heads/${details.branch}`]);
    const headSha = head.stdout.trim();
    if (remoteHead.exitCode !== 0 || !remoteHead.stdout.startsWith(headSha)) throw new Error("Verified commit is not pushed to the task branch.");
    const existing = await this.localWorker.gh(worker, details.worktreePath, ["pr", "view", details.branch, "--json", "url", "--jq", ".url"]);
    if (existing.exitCode === 0 && /^https:\/\//.test(existing.stdout.trim())) return { headSha, prUrl: existing.stdout.trim() };
    const created = await this.localWorker.gh(worker, details.worktreePath, [
      "pr", "create", "--draft", "--base", project.defaultBranch, "--head", details.branch,
      "--title", `ClawBridge task ${taskId}`, "--body", `Automated delivery for ClawBridge task ${taskId}.\n\nAwaiting Codex review.`,
    ]);
    const prUrl = created.stdout.trim().split(/\s+/).find((value) => /^https:\/\//.test(value));
    if (created.exitCode !== 0 || !prUrl) throw new Error(`Could not create draft PR: ${created.stderr.slice(-1_000) || "No URL returned."}`);
    return { headSha, prUrl };
  }
}

function developmentPrompt(task: CloudTask, baseSha: string, branch: string): string {
  return `ClawBridge task ${task.taskId}\nBase SHA: ${baseSha}\nTask branch: ${branch}\n\n${task.spec}\n\nWork only in this prepared worktree. Do not create another worktree, switch branches, merge, deploy, release, or access credentials. Commit the completed work and report exact test commands and commit SHA.`;
}
function permissionMode(profile: string | undefined): "default" | "acceptEdits" | "auto" {
  return profile === "acceptEdits" || profile === "auto" ? profile : "default";
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown worker error."; }
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
