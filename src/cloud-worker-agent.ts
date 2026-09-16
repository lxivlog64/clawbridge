import { CodeBuddyClient, type CodeBuddyTranscript } from "./codebuddy-client.js";
import { CloudControlClient } from "./cloud-control-client.js";
import type { CloudTask, CloudTaskState } from "./cloud-task-store.js";
import { mapRemoteState } from "./lifecycle.js";
import type { ProjectRegistry } from "./project-registry.js";
import { LocalWorker } from "./remote-worker.js";
import { prepareWorktree, type GitPreparerRemote } from "./worktree-preparer.js";

type CloudControlGateway = Pick<CloudControlClient, "heartbeat" | "claim" | "update"> & Partial<Pick<CloudControlClient, "workerTask" | "activeTasks">>;
type CodeBuddyGateway = Pick<CodeBuddyClient, "dispatchJob" | "getJob"> & Partial<Pick<CodeBuddyClient, "stop" | "transcript">>;
interface LocalExecutionWorker extends GitPreparerRemote {
  gh(worker: Parameters<LocalWorker["gh"]>[0], cwd: string, args: string[]): ReturnType<LocalWorker["gh"]>;
}
/** Persisted coordinates of an accepted remote job, retained even when its final outcome is unknown. */
type BackgroundPermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk";
type JobDetails = { remoteJobId: string; worktreePath: string; baseSha: string; branch: string; deadlineAt?: string; dispatchedAt?: string; requestedModel?: string; permissionMode?: BackgroundPermissionMode };

export interface CloudWorkerAgentOptions {
  workerId: string;
  projects: ProjectRegistry;
  control: CloudControlGateway;
  codeBuddy: CodeBuddyGateway;
  pollMs?: number;
  permissionPendingMs?: number;
  localWorker?: LocalExecutionWorker;
}

/** Runs on the private Worker host. It never exposes CodeBuddy or GitHub credentials to the VPS. */
export class CloudWorkerAgent {
  private readonly pollMs: number;
  private readonly permissionPendingMs: number;
  private readonly localWorker: LocalExecutionWorker;

  constructor(private readonly options: CloudWorkerAgentOptions) {
    this.pollMs = options.pollMs ?? 10_000;
    this.permissionPendingMs = options.permissionPendingMs ?? 120_000;
    this.localWorker = options.localWorker ?? new LocalWorker();
  }

  async once(signal?: AbortSignal): Promise<boolean> {
    await this.options.control.heartbeat(this.options.workerId, { version: "0.1.0", runtime: "node" });
    if (await this.resumeActiveTask(signal)) return true;
    if (signal?.aborted) return false;
    const claimed = await this.options.control.claim(this.options.workerId);
    if (!claimed.task) return false;
    await this.execute(claimed.task, signal);
    return true;
  }

  private async resumeActiveTask(signal?: AbortSignal): Promise<boolean> {
    if (!this.options.control.activeTasks) return false;
    const task = (await this.options.control.activeTasks(this.options.workerId))[0];
    if (!task) return false;
    const details = jobDetails(task.result, permissionMode(this.options.projects.require(task.projectId).permissionProfile));
    if (!details) {
      await this.options.control.update(task.taskId, "unknown", {
        ...(task.result ?? {}),
        error: "Worker restarted before accepted CodeBuddy job coordinates were persisted; manual reconciliation is required.",
      });
      return true;
    }
    try {
      await this.awaitCompletion(task.taskId, task.projectId, details, signal);
    } catch (error) {
      if (signal?.aborted) return true;
      await this.options.control.update(task.taskId, "unknown", { ...details, error: message(error) });
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.once(signal); }
      catch (error) { console.error(JSON.stringify({ event: "worker.poll_failed", error: message(error), at: new Date().toISOString() })); }
      await wait(this.pollMs, signal);
    }
  }

  private async execute(task: CloudTask, signal?: AbortSignal): Promise<void> {
    // Set once CodeBuddy accepts the job. From that point on a local error is
    // ambiguous: the remote job may still be running, so it must not be
    // reported as a terminal failure or silently retried.
    let accepted: JobDetails | undefined;
    try {
      const project = this.options.projects.require(task.projectId);
      if (project.workerId !== this.options.workerId) throw new Error("Task is assigned to a different worker.");
      const preflight = this.options.projects.preflight(project.id);
      if (!preflight.ready) throw new Error(preflight.blockers.join(" "));
      if (signal?.aborted) return;
      const worker = this.options.projects.workerFor(project.id);
      const prepared = await prepareWorktree(
        task.taskId, project, worker, this.localWorker,
        (candidate) => this.options.projects.allowsPath(project.id, candidate),
        reconciledRetry(task),
      );
      if (!prepared.ok) throw new Error(prepared.reason);
      if (await this.cancelRequested(task.taskId)) {
        await this.options.control.update(task.taskId, "cancelled", { cancellation: "cancelled before CodeBuddy dispatch" });
        return;
      }
      const taskPermissionMode = permissionMode(project.permissionProfile);
      const job = await this.options.codeBuddy.dispatchJob({
        cwd: prepared.worktreePath,
        prompt: developmentPrompt(task, prepared.baseSha, prepared.branch, project.maxRepairRounds),
        model: task.requestedModel,
        permissionMode: taskPermissionMode,
        allowedTools: project.allowedTools,
        ...(project.allowedTools.length > 0 ? { settings: permissionSettings(project.allowedTools) } : {}),
        name: `clawbridge-${task.taskId}`,
        bgIsolation: "none",
      });
      if (!job.id) throw new Error("CodeBuddy gateway returned no job id.");
      accepted = {
        remoteJobId: job.id, worktreePath: prepared.worktreePath, baseSha: prepared.baseSha, branch: prepared.branch,
        deadlineAt: new Date(Date.now() + project.maxRuntimeMinutes * 60_000).toISOString(),
        dispatchedAt: new Date().toISOString(), requestedModel: task.requestedModel, permissionMode: taskPermissionMode,
      };
      if (!await this.updateReliably(task.taskId, "running", { ...accepted, usage: usageSnapshot(accepted, job) }, signal)) return;
      await this.awaitCompletion(task.taskId, task.projectId, accepted, signal);
    } catch (error) {
      // Before a remote job id exists nothing was dispatched, so the attempt is
      // safely failed. Afterwards the remote job may still be running, so the
      // outcome is unknown and must be reconciled by an operator, not retried here.
      if (signal?.aborted) return;
      if (accepted) await this.options.control.update(task.taskId, "unknown", { ...accepted, usage: usageSnapshot(accepted), error: message(error) });
      else await this.options.control.update(task.taskId, "failed", { error: message(error) });
    }
  }

  private async awaitCompletion(taskId: string, projectId: string, details: JobDetails, signal?: AbortSignal): Promise<void> {
    while (true) {
      // A clean service stop is not an execution failure. Keep the persisted
      // coordinates and let the next Worker process recover the same job.
      if (signal?.aborted) return;
      if (await this.cancelRequested(taskId)) {
        if (!this.options.codeBuddy.stop) throw new Error("CodeBuddy gateway does not support job cancellation.");
        await this.options.codeBuddy.stop(details.remoteJobId);
        await this.updateReliably(taskId, "cancelled", { ...details, usage: usageSnapshot(details), cancellation: "CodeBuddy stop requested by client" }, signal);
        return;
      }
      if (details.deadlineAt && Date.parse(details.deadlineAt) <= Date.now()) {
        if (!this.options.codeBuddy.stop) throw new Error("CodeBuddy gateway does not support job timeout cancellation.");
        await this.options.codeBuddy.stop(details.remoteJobId);
        await this.updateReliably(taskId, "failed", { ...details, usage: usageSnapshot(details), error: "Task exceeded its configured runtime limit." }, signal);
        return;
      }
      let job: Record<string, unknown>;
      try {
        job = await this.options.codeBuddy.getJob(details.remoteJobId);
      } catch (error) {
        // A transient gateway/network error does not make the accepted remote
        // job unknown. Retain the lease and coordinates, then retry polling.
        await this.updateReliably(taskId, "running", {
          ...details, usage: usageSnapshot(details), pollWarning: message(error),
        }, signal);
        await wait(this.pollMs, signal);
        continue;
      }
      const state = mapRemoteState(job.state, job.status, job.alive, job.settled);
      if (state === "running" || state === "waiting_input") {
        const pendingTool = await this.pendingToolState(details);
        const activeState = pendingTool ?? state;
        await this.updateReliably(taskId, activeState, {
          ...details, usage: usageSnapshot(details, job),
          ...(pendingTool === "waiting_permission" ? { blockReason: "CodeBuddy has an executable tool call waiting for permission." } : {}),
          ...(pendingTool === "stalled" ? { blockReason: "CodeBuddy has a subagent call with no completion event; the job is stalled rather than actively developing." } : {}),
        }, signal);
        await wait(this.pollMs, signal);
        continue;
      }
      if (state !== "succeeded") {
        await this.updateReliably(taskId, state === "failed" || state === "cancelled" ? state : "unknown", { ...details, usage: usageSnapshot(details, job), remoteState: state }, signal);
        return;
      }
      const terminalError = terminalJobError(job);
      if (terminalError) {
        await this.updateReliably(taskId, "failed", {
          ...details, usage: usageSnapshot(details, job), remoteState: "failed", error: terminalError,
        }, signal);
        return;
      }
      try {
        const delivery = await this.deliver(taskId, projectId, details);
        await this.updateReliably(taskId, "succeeded", { ...details, usage: usageSnapshot(details, job), ...delivery }, signal);
      } catch (error) {
        // The CodeBuddy job is already settled, so a verification/delivery
        // error is a known terminal failure rather than an ambiguous outcome.
        await this.updateReliably(taskId, "failed", {
          ...details, usage: usageSnapshot(details, job), remoteState: "succeeded", error: message(error),
        }, signal);
      }
      return;
    }
  }

  private async pendingToolState(details: JobDetails): Promise<"waiting_permission" | "stalled" | undefined> {
    if (!this.options.codeBuddy.transcript) return undefined;
    try {
      const transcript = await this.options.codeBuddy.transcript(details.remoteJobId);
      if (hasAgedPendingSubagent(transcript, Date.now(), this.permissionPendingMs)) return "stalled";
      if (details.permissionMode !== "auto" && details.permissionMode !== "dontAsk" && hasAgedPendingExecutable(transcript, Date.now(), this.permissionPendingMs)) return "waiting_permission";
      return undefined;
    } catch {
      // Status polling remains authoritative when the optional diagnostic
      // transcript endpoint is unavailable.
      return undefined;
    }
  }

  /** Retain accepted-job ownership through transient control-plane outages. */
  private async updateReliably(taskId: string, state: Exclude<CloudTaskState, "queued" | "leased">, result: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    while (!signal?.aborted) {
      try {
        await this.options.control.update(taskId, state, result);
        return true;
      } catch (error) {
        console.error(JSON.stringify({ event: "worker.update_retry", taskId, state, error: message(error), at: new Date().toISOString() }));
        await wait(this.pollMs, signal);
      }
    }
    return false;
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
    const headSha = head.stdout.trim();
    const currentBranch = await this.localWorker.git(worker, details.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== details.branch || details.branch === project.defaultBranch) throw new Error("Task worktree is not on its recorded delivery branch.");
    const status = await this.localWorker.git(worker, details.worktreePath, ["status", "--porcelain"]);
    if (status.exitCode !== 0) throw new Error("Cannot inspect task worktree before delivery.");
    if (status.stdout.trim()) throw new Error("CodeBuddy completed with uncommitted changes; resume the same task worktree and commit them before delivery.");
    if (headSha === details.baseSha) throw new Error("CodeBuddy completed without creating a task commit.");
    const pushed = await this.localWorker.git(worker, details.worktreePath, ["push", "--set-upstream", project.deliveryRemote, details.branch]);
    if (pushed.exitCode !== 0) throw new Error(`Could not push task branch: ${pushed.stderr.slice(-1_000)}`);
    const remoteHead = await this.localWorker.git(worker, details.worktreePath, ["ls-remote", project.deliveryRemote, `refs/heads/${details.branch}`]);
    if (remoteHead.exitCode !== 0 || !remoteHead.stdout.startsWith(headSha)) throw new Error("Verified commit is not pushed to the task branch.");
    const existing = await this.localWorker.gh(worker, details.worktreePath, ["pr", "view", details.branch, "--json", "url", "--jq", ".url"]);
    if (existing.exitCode === 0 && /^https:\/\//.test(existing.stdout.trim())) return { headSha, prUrl: existing.stdout.trim() };
    const created = await this.localWorker.gh(worker, details.worktreePath, [
      "pr", "create", "--draft", "--base", project.defaultBranch, "--head", details.branch,
      "--title", `鲁班任务 ${taskId}`, "--body", `鲁班自动交付任务 ${taskId}。\n\n等待 Codex 审查。`,
    ]);
    const prUrl = created.stdout.trim().split(/\s+/).find((value) => /^https:\/\//.test(value));
    if (created.exitCode !== 0 || !prUrl) throw new Error(`Could not create draft PR: ${created.stderr.slice(-1_000) || "No URL returned."}`);
    return { headSha, prUrl };
  }
}

function developmentPrompt(task: CloudTask, baseSha: string, branch: string, maxRepairRounds: number): string {
  return `Luban task ${task.taskId}\nBase SHA: ${baseSha}\nTask branch: ${branch}\n\n${task.spec}\n\nWork only in this prepared worktree. Do not create another worktree, switch branches, merge, deploy, release, or access credentials. Do not use Agent, subagent, team, delegation, or background-agent tools; inspect and edit the repository directly with Read, Glob, Grep, Edit, Write, and permitted Bash commands. Use one command per Bash tool call; do not join commands with &&, ;, pipes, or command substitution because this project uses exact command allowlists. The Worker, not you, pushes the branch and creates the draft PR after verifying your commit. Run at most ${maxRepairRounds} repair round(s) after the initial implementation and tests; if still failing, stop and report the blocker. Commit the completed work and report exact test commands and commit SHA.`;
}
function permissionMode(profile: string | undefined): BackgroundPermissionMode {
  return profile === "default" || profile === "acceptEdits" || profile === "auto" || profile === "dontAsk" ? profile : "auto";
}
function permissionSettings(allowedTools: string[]): string {
  return JSON.stringify({ permissions: { allow: allowedTools, disableBypassPermissionsMode: "disable" } });
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown worker error."; }
function jobDetails(result: Record<string, unknown> | undefined, fallbackPermissionMode?: BackgroundPermissionMode): JobDetails | undefined {
  if (!result) return undefined;
  const { remoteJobId, worktreePath, baseSha, branch, deadlineAt, dispatchedAt, requestedModel, permissionMode: storedPermissionMode } = result;
  const restoredPermissionMode = storedPermissionMode === "default" || storedPermissionMode === "acceptEdits" || storedPermissionMode === "auto" || storedPermissionMode === "dontAsk" ? storedPermissionMode : fallbackPermissionMode;
  return typeof remoteJobId === "string" && typeof worktreePath === "string" && typeof baseSha === "string" && typeof branch === "string"
    ? { remoteJobId, worktreePath, baseSha, branch, ...(typeof deadlineAt === "string" ? { deadlineAt } : {}), ...(typeof dispatchedAt === "string" ? { dispatchedAt } : {}), ...(typeof requestedModel === "string" ? { requestedModel } : {}), ...(restoredPermissionMode ? { permissionMode: restoredPermissionMode } : {}) }
    : undefined;
}

export function hasAgedPendingExecutable(transcript: CodeBuddyTranscript, nowMs: number, minimumAgeMs: number): boolean {
  const completed = new Set<string>();
  for (const update of transcript.updates) {
    const record = object(update);
    if (record?.sessionUpdate !== "tool_call_update" || typeof record.toolCallId !== "string" || record.status === "pending") continue;
    completed.add(record.toolCallId);
  }
  return transcript.updates.some((update) => {
    const record = object(update);
    if (record?.sessionUpdate !== "tool_call" || record.status !== "pending" || record.kind !== "execute" || typeof record.toolCallId !== "string" || completed.has(record.toolCallId)) return false;
    const metadata = object(record._meta);
    const timestamp = typeof metadata?.timestamp === "string" ? Date.parse(metadata.timestamp) : Number.NaN;
    return Number.isFinite(timestamp) && nowMs - timestamp >= minimumAgeMs;
  });
}

export function hasAgedPendingSubagent(transcript: CodeBuddyTranscript, nowMs: number, minimumAgeMs: number): boolean {
  const completed = completedToolCalls(transcript);
  return transcript.updates.some((update) => {
    const record = object(update);
    if (record?.sessionUpdate !== "tool_call" || record.status !== "pending" || typeof record.toolCallId !== "string" || completed.has(record.toolCallId)) return false;
    const metadata = object(record._meta);
    if (metadata?.toolName !== "Agent" && metadata?.isSubagent !== true) return false;
    const timestamp = typeof metadata?.timestamp === "string" ? Date.parse(metadata.timestamp) : Number.NaN;
    return Number.isFinite(timestamp) && nowMs - timestamp >= minimumAgeMs;
  });
}

function completedToolCalls(transcript: CodeBuddyTranscript): Set<string> {
  const completed = new Set<string>();
  for (const update of transcript.updates) {
    const record = object(update);
    if (record?.sessionUpdate === "tool_call_update" && typeof record.toolCallId === "string" && record.status !== "pending") completed.add(record.toolCallId);
  }
  return completed;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function usageSnapshot(details: JobDetails, job?: Record<string, unknown>): Record<string, string | number> {
  const observedModel = stringAt(job, ["model"]) ?? stringAt(job, ["modelId"]) ?? stringAt(job, ["metadata", "model"]);
  const started = details.dispatchedAt ? Date.parse(details.dispatchedAt) : Number.NaN;
  return {
    requestedModel: details.requestedModel ?? "unknown",
    observedModel: observedModel ?? "unknown",
    durationMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : "unknown",
    inputTokens: numberAt(job, ["usage", "inputTokens"]) ?? numberAt(job, ["usage", "input_tokens"]) ?? numberAt(job, ["inputTokens"]) ?? "unknown",
    outputTokens: numberAt(job, ["usage", "outputTokens"]) ?? numberAt(job, ["usage", "output_tokens"]) ?? numberAt(job, ["outputTokens"]) ?? "unknown",
    credits: numberAt(job, ["usage", "credits"]) ?? numberAt(job, ["creditsUsed"]) ?? "unknown",
  };
}
function stringAt(value: unknown, path: string[]): string | undefined {
  const found = at(value, path); return typeof found === "string" && found ? found : undefined;
}
function numberAt(value: unknown, path: string[]): number | undefined {
  const found = at(value, path); return typeof found === "number" && Number.isFinite(found) && found >= 0 ? found : undefined;
}
function terminalJobError(job: Record<string, unknown>): string | undefined {
  const candidates = [
    stringAt(job, ["error"]), stringAt(job, ["detail"]),
    stringAt(job, ["output", "error"]), stringAt(job, ["output", "result"]),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((value) =>
    /(?:^|\b)(?:4\d\d|5\d\d)(?:\b|\s)|rate\s*limit|usage\s+(?:limit|exceeded)|频率限制|使用量.{0,12}(?:超出|限制)/i.test(value),
  )?.slice(0, 2_000);
}
function at(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function reconciledRetry(task: CloudTask): { priorBaseSha: string } | undefined {
  const reconciliation = task.result?.reconciliation;
  if (!reconciliation || typeof reconciliation !== "object") return undefined;
  const record = reconciliation as Record<string, unknown>;
  return record.action === "requeue" && record.remoteJobConfirmedStopped === true && typeof task.result?.baseSha === "string"
    ? { priorBaseSha: task.result.baseSha }
    : undefined;
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
