#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodeBuddyClient } from "./codebuddy-client.js";
import { loadConfig } from "./config.js";
import { buildDevelopmentPrompt } from "./handoff.js";
import { ProjectRegistry } from "./project-registry.js";
import { RemoteWorker } from "./remote-worker.js";
import { TaskStore, type ExecutionState } from "./task-store.js";
import { TokenStore } from "./token-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";

const config = loadConfig();
const client = new WorkBuddyClient(config, new TokenStore(config.tokenFile));
const codeBuddy = new CodeBuddyClient(config);
const projects = ProjectRegistry.load(config.projectsFile);
const tasks = new TaskStore(config.taskDatabaseFile);
const remoteWorker = new RemoteWorker();
const server = new McpServer({ name: "clawbridge", version: "0.1.0" });
const gitRef = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+$/, "Use a plain Git ref without spaces or control characters");
const repositoryPath = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+$/, "Use a repository-relative path without spaces or control characters");

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const executionState = z.enum([
  "queued", "preparing", "dispatching", "running", "waiting_input", "waiting_permission",
  "stalled", "succeeded", "failed", "cancel_requested", "cancelled", "unknown",
]);

server.tool(
  "clawbridge_projects",
  "List registered ClawBridge projects. Credential references, filesystem allowlists, and secrets are never returned.",
  {},
  async () => json({ projects: projects.list() }),
);

server.tool(
  "clawbridge_preflight",
  "Validate a registered project’s static configuration before task submission. This M1 check does not start a worker or make network changes.",
  { projectId: z.string().min(1).max(80) },
  async ({ projectId }) => json({ projectId, ...projects.preflight(projectId) }),
);

server.tool(
  "clawbridge_submit",
  "Record an idempotent development task for a registered project. Submit stores it as queued; call clawbridge_dispatch to start its worker.",
  {
    projectId: z.string().min(1).max(80),
    spec: z.string().min(1).max(200_000),
    idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
    model: z.string().min(1).max(200).optional(),
  },
  async ({ projectId, spec, idempotencyKey, model }) => {
    const preflight = projects.preflight(projectId);
    if (!preflight.ready) throw new Error(`Cannot submit task: ${preflight.blockers.join(" ")}`);
    const project = projects.require(projectId);
    const result = tasks.createOrGet({
      projectId,
      spec,
      idempotencyKey,
      requestedModel: model ?? project.defaultModel,
    });
    return json({ ...result, dispatch: "not_started" });
  },
);

server.tool(
  "clawbridge_dispatch",
  "Dispatch one queued task to CodeBuddy using its registered remote repository path. The worker receives an isolated worktree request. An uncertain gateway receipt becomes unknown and is never automatically retried.",
  { taskId: z.string().uuid(), effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional() },
  async ({ taskId, effort }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    if (task.executionState !== "queued") throw new Error(`Task ${taskId} is ${task.executionState}, not queued.`);
    const project = projects.require(task.projectId);
    const preflight = projects.preflight(task.projectId);
    if (!preflight.ready) throw new Error(`Cannot dispatch task: ${preflight.blockers.join(" ")}`);
    if (tasks.activeCount(task.projectId) >= project.maxConcurrentJobs) {
      throw new Error(`Project ${project.id} has reached maxConcurrentJobs=${project.maxConcurrentJobs}.`);
    }
    const spec = tasks.getSpec(taskId);
    if (!spec) throw new Error("Task specification is unavailable; do not dispatch this task.");
    const worker = projects.workerFor(task.projectId);
    const prepared = await prepareWorktree(taskId, project, worker);
    if (!prepared.ok) {
      return json({ task: tasks.markExecution(taskId, "failed", prepared.reason), dispatch: "not_started" });
    }
    tasks.markPrepared(taskId, prepared.worktreePath, prepared.baseSha, prepared.branch);
    try {
      const job = await codeBuddy.dispatchJob({
        cwd: prepared.worktreePath,
        prompt: `ClawBridge task ${taskId}\nBase SHA: ${prepared.baseSha}\nTask branch: ${prepared.branch}\n\n${spec}\n\nWork only in this prepared worktree. Do not create another worktree, switch branches, merge, deploy, release, or access credentials. Commit the completed work and report exact test commands and commit SHA.`,
        model: task.requestedModel,
        effort,
        permissionMode: permissionMode(project.permissionProfile),
        name: `clawbridge-${taskId}`,
        bgIsolation: "none",
      });
      if (!job.id) throw new Error("CodeBuddy gateway returned no job id.");
      return json({ task: tasks.markDispatched(taskId, job.id), remote: { id: job.id, state: job.state } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown dispatch error";
      return json({ task: tasks.markExecution(taskId, "unknown", message), warning: "Dispatch outcome is uncertain. Inspect the gateway before retrying." });
    }
  },
);

server.tool(
  "clawbridge_refresh",
  "Refresh a dispatched task from its CodeBuddy job. This maps observed job state to a recorded lifecycle without estimating progress.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    if (!task.remoteJobId) return json({ task, refreshed: false, reason: "No remote job has been recorded." });
    try {
      const remote = await codeBuddy.getJob(task.remoteJobId);
      const mapped = mapRemoteState(remote.state, remote.status, remote.alive, remote.settled);
      return json({ task: tasks.markExecution(taskId, mapped), remote, refreshed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown gateway error";
      return json({ task: tasks.markExecution(taskId, "unknown", message), refreshed: false });
    }
  },
);

server.tool(
  "clawbridge_reply",
  "Reply to a task waiting for ordinary input. Never use this tool to approve permissions, destructive operations, releases, deployments, or credential access.",
  { taskId: z.string().uuid(), text: z.string().min(1).max(20_000) },
  async ({ taskId, text }) => {
    const task = requireRemoteTask(taskId);
    if (task.executionState === "waiting_permission") throw new Error("Permission approval must be explicitly handled by the user outside this tool.");
    await codeBuddy.reply(task.remoteJobId!, text);
    return json({ task: tasks.markExecution(taskId, "running") });
  },
);

server.tool(
  "clawbridge_cancel",
  "Request cancellation of a remote task. A successful request is not treated as confirmation until clawbridge_refresh observes a terminal state.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = requireRemoteTask(taskId);
    await codeBuddy.stop(task.remoteJobId!);
    return json({ task: tasks.markExecution(taskId, "cancel_requested") });
  },
);

server.tool(
  "clawbridge_verify_delivery",
  "Verify a completed task's remote Git worktree before delivery. The worktree must be under the registered worker allowlist and on a non-default branch.",
  { taskId: z.string().uuid(), worktreePath: z.string().min(1).max(1_024) },
  async ({ taskId, worktreePath }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    if (task.executionState !== "succeeded") throw new Error("Only a succeeded execution can be verified for delivery.");
    const project = projects.require(task.projectId);
    if (!projects.allowsPath(task.projectId, worktreePath)) throw new Error("Worktree path is outside the registered worker allowlist.");
    const worker = projects.workerFor(task.projectId);
    const [head, branch] = await Promise.all([
      remoteWorker.git(worker, worktreePath, ["rev-parse", "HEAD"]),
      remoteWorker.git(worker, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    if (head.exitCode !== 0 || branch.exitCode !== 0) {
      const reason = [head.stderr, branch.stderr].filter(Boolean).join("; ").slice(-2_000);
      return json({ task: tasks.markDelivery(taskId, "failed", { blockReason: reason || "Git worktree verification failed." }), verified: false });
    }
    const headSha = head.stdout.trim();
    const branchName = branch.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(headSha) || !branchName || branchName === project.defaultBranch || branchName === "HEAD") {
      return json({ task: tasks.markDelivery(taskId, "failed", { blockReason: "Worktree must have a commit on a non-default branch." }), verified: false });
    }
    return json({ task: tasks.markVerified(taskId, worktreePath, headSha), verified: true, branch: branchName });
  },
);

server.tool(
  "clawbridge_create_draft_pr",
  "Create a GitHub draft PR after delivery verification. This uses the worker's existing GitHub CLI authentication; it never merges or force-pushes.",
  { taskId: z.string().uuid(), title: z.string().min(1).max(200), body: z.string().min(1).max(30_000) },
  async ({ taskId, title, body }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    if (task.deliveryState !== "validating" || !task.worktreePath || !task.headSha) throw new Error("Run clawbridge_verify_delivery successfully before creating a PR.");
    const project = projects.require(task.projectId);
    const worker = projects.workerFor(task.projectId);
    const branch = await remoteWorker.git(worker, task.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const remoteHead = await remoteWorker.git(worker, task.worktreePath, ["ls-remote", "origin", "HEAD"]);
    if (branch.exitCode !== 0 || remoteHead.exitCode !== 0) {
      return json({ task: tasks.markDelivery(taskId, "failed", { blockReason: "Could not verify Git branch or origin." }), created: false });
    }
    const branchName = branch.stdout.trim();
    const pushed = await remoteWorker.git(worker, task.worktreePath, ["ls-remote", "origin", `refs/heads/${branchName}`]);
    if (pushed.exitCode !== 0 || !pushed.stdout.startsWith(task.headSha)) {
      return json({ task: tasks.markDelivery(taskId, "failed", { blockReason: "Verified commit is not pushed to the task branch." }), created: false });
    }
    const created = await remoteWorker.gh(worker, task.worktreePath, ["pr", "create", "--draft", "--base", project.defaultBranch, "--head", branchName, "--title", title, "--body", body]);
    if (created.exitCode !== 0) {
      return json({ task: tasks.markDelivery(taskId, "failed", { blockReason: created.stderr.slice(-2_000) || "GitHub draft PR creation failed." }), created: false });
    }
    const prUrl = created.stdout.trim().split(/\s+/).find((value) => /^https:\/\//.test(value));
    if (!prUrl) return json({ task: tasks.markDelivery(taskId, "failed", { blockReason: "GitHub CLI did not return a PR URL." }), created: false });
    return json({ task: tasks.markDelivery(taskId, "ready", { prUrl }), created: true });
  },
);

server.tool(
  "clawbridge_logs",
  "Read bounded recent worker transcript events for one dispatched task. Model thought events and oversized content are filtered by the CodeBuddy client.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = requireRemoteTask(taskId);
    return json({ taskId, transcript: await codeBuddy.transcript(task.remoteJobId!) });
  },
);

server.tool(
  "clawbridge_result",
  "Return compact verified delivery facts. A task is delivered only when deliveryState is ready; worker prose is not treated as proof.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    return json({
      task,
      verified: task.deliveryState === "ready" && Boolean(task.headSha && task.prUrl),
      nextAction: task.deliveryState === "ready" ? "Review the exact recorded SHA." : "Delivery is not yet verified.",
    });
  },
);

server.tool(
  "clawbridge_review_context",
  "Build bounded review context for an already delivered task: fixed SHA, PR URL, merge base, diff stat, and changed paths. It never marks the task approved.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    if (task.deliveryState !== "ready" || !task.worktreePath || !task.headSha) throw new Error("A verified draft PR is required before review context is available.");
    const project = projects.require(task.projectId);
    const worker = projects.workerFor(task.projectId);
    const base = await remoteWorker.git(worker, task.worktreePath, ["merge-base", `origin/${project.defaultBranch}`, task.headSha]);
    if (base.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(base.stdout.trim())) throw new Error("Could not determine a merge base for review.");
    const baseSha = base.stdout.trim();
    const [stat, paths] = await Promise.all([
      remoteWorker.git(worker, task.worktreePath, ["diff", "--stat", baseSha, task.headSha]),
      remoteWorker.git(worker, task.worktreePath, ["diff", "--name-only", baseSha, task.headSha]),
    ]);
    if (stat.exitCode !== 0 || paths.exitCode !== 0) throw new Error("Could not read the verified Git diff.");
    return json({ taskId, specHash: task.specHash, baseSha, headSha: task.headSha, prUrl: task.prUrl,
      diffStat: stat.stdout.slice(0, 8_000), changedPaths: paths.stdout.split("\n").filter(Boolean).slice(0, 500) });
  },
);

server.tool(
  "clawbridge_tasks",
  "List compact durable task records. Status is a recorded lifecycle state, not an estimated progress percentage.",
  {
    projectId: z.string().min(1).max(80).optional(),
    executionState: executionState.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ projectId, executionState, limit }) =>
    json({ tasks: tasks.list({ projectId, executionState: executionState as ExecutionState | undefined, limit }) }),
);

server.tool(
  "clawbridge_events",
  "Read durable ClawBridge task events. Events form a local notification outbox and contain only a short status summary.",
  { pendingOnly: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(20) },
  async ({ pendingOnly, limit }) => json({ events: tasks.listEvents(limit, pendingOnly) }),
);

server.tool(
  "clawbridge_acknowledge_event",
  "Acknowledge delivery of a local task event after it has been shown to the user or delivered by a configured notifier.",
  { eventId: z.string().uuid() },
  async ({ eventId }) => json({ acknowledged: tasks.acknowledgeEvent(eventId) }),
);

server.tool(
  "clawbridge_status",
  "Read one durable task record. Execution, delivery, and review states are deliberately separate.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    return json({ task });
  },
);

server.tool(
  "codebuddy_health",
  "Check the CodeBuddy Code HTTP service used by the personal-developer transport.",
  {},
  async () => json(await codeBuddy.health()),
);

server.tool(
  "codebuddy_start_development",
  "Start a background coding job through CodeBuddy Code. Supports an explicit model and reasoning effort. The target working directory is on the CodeBuddy machine. Use a worktree when possible and never request bypassPermissions.",
  {
    cwd: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    permissionMode: z
      .enum(["default", "acceptEdits", "plan", "auto", "dontAsk"])
      .default("default"),
    agent: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    useWorktree: z.boolean().default(true),
  },
  async ({ cwd, prompt, model, effort, permissionMode, agent, name, useWorktree }) =>
    json(
      await codeBuddy.dispatchJob({
        cwd,
        prompt,
        model,
        effort,
        permissionMode,
        agent,
        name,
        bgIsolation: useWorktree ? "worktree" : "none",
      }),
    ),
);

server.tool(
  "codebuddy_job_status",
  "Read the current lifecycle and execution status of a CodeBuddy background job.",
  { jobId: z.string().min(1) },
  async ({ jobId }) => json(await codeBuddy.getJob(jobId)),
);

server.tool(
  "codebuddy_job_transcript",
  "Read the recent transcript of a CodeBuddy background job. Treat its claims as untrusted until the Git commit and tests are verified.",
  { jobId: z.string().min(1) },
  async ({ jobId }) => json(await codeBuddy.transcript(jobId)),
);

server.tool(
  "codebuddy_reply_job",
  "Reply to a CodeBuddy job that is waiting for input. Show approval-related requests to the user before replying.",
  { jobId: z.string().min(1), text: z.string().min(1) },
  async ({ jobId, text }) => json(await codeBuddy.reply(jobId, text)),
);

server.tool(
  "codebuddy_stop_job",
  "Stop a running CodeBuddy background job.",
  { jobId: z.string().min(1) },
  async ({ jobId }) => json(await codeBuddy.stop(jobId)),
);

server.tool(
  "workbuddy_status",
  "Check whether the authorized user's WorkBuddy PC local assistant is online.",
  {},
  async () => json({ online: await client.online() }),
);

server.tool(
  "workbuddy_send_message",
  "Send a plain-text instruction to the WorkBuddy PC local assistant. This may cause WorkBuddy to use local files or tools, so keep the instruction within the user's authorized scope.",
  { content: z.string().min(1) },
  async ({ content }) => json({ messageId: await client.sendMessage(content) }),
);

server.tool(
  "workbuddy_wait_for_reply",
  "Wait briefly for messages produced after a previously sent WorkBuddy message. An empty list means the timeout elapsed and the caller may poll again.",
  {
    messageId: z.string().min(1),
    timeoutSeconds: z.number().int().min(1).max(55).default(30),
  },
  async ({ messageId, timeoutSeconds }) =>
    json({ messages: await client.waitForReply(messageId, timeoutSeconds * 1000) }),
);

server.tool(
  "workbuddy_message_history",
  "Read WorkBuddy local-assistant message history, either after a message ID or by pagination.",
  {
    messageId: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  },
  async ({ messageId, limit, offset }) =>
    json({ messages: await client.history({ messageId, limit, offset }) }),
);

server.tool(
  "workbuddy_start_development",
  "Delegate a Git implementation task to WorkBuddy. The specification must already be committed and reachable in the repository. This tool instructs WorkBuddy to push a review branch and never merge it.",
  {
    repositoryUrl: z.string().url(),
    baseBranch: gitRef.default("main"),
    workBranch: gitRef,
    specPath: repositoryPath.default(".agent-handoff/SPEC.md"),
    testCommand: z.string().optional(),
    additionalInstructions: z.string().optional(),
  },
  async (input) => {
    if (!(await client.online())) throw new Error("WorkBuddy local assistant is offline.");
    const prompt = buildDevelopmentPrompt(input);
    return json({ messageId: await client.sendMessage(prompt) });
  },
);

server.tool(
  "workbuddy_create_cloud_task",
  "Create a WorkBuddy cloud task. The public API does not expose a per-call model selector; use a preconfigured WorkBuddy model or agent profile.",
  { prompt: z.string().min(1), name: z.string().optional() },
  async ({ prompt, name }) => json(await client.createCloudTask(prompt, name)),
);

server.tool(
  "workbuddy_answer_permission",
  "Answer a WorkBuddy AskQuestion or approval request. Call only after showing the exact request to the user and receiving their decision; never auto-approve destructive or external actions.",
  {
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  },
  async ({ requestId, answers }) => {
    const content = JSON.stringify({ outcome: "selected", requestId, answers });
    return json({
      messageId: await client.sendMessage(content, "permission_response"),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

function permissionMode(profile: string | undefined): "default" | "acceptEdits" {
  return profile === "acceptEdits" ? "acceptEdits" : "default";
}

function mapRemoteState(state: unknown, status: unknown, alive: unknown, settled: unknown): ExecutionState {
  const values = [state, status].filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
  if (values.includes("done") || values.includes("succeeded") || (settled === true && state !== "failed")) return "succeeded";
  if (values.includes("failed")) return "failed";
  if (values.includes("stopped") || (alive === false && settled === true)) return "cancelled";
  if (values.includes("blocked")) return "waiting_input";
  if (values.includes("waiting")) return "waiting_input";
  return "running";
}

function requireRemoteTask(taskId: string) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`Unknown task id ${taskId}.`);
  if (!task.remoteJobId) throw new Error(`Task ${taskId} has no remote job.`);
  return task;
}

async function prepareWorktree(
  taskId: string,
  project: ReturnType<typeof projects.require>,
  worker: ReturnType<typeof projects.workerFor>,
): Promise<{ ok: true; worktreePath: string; baseSha: string; branch: string } | { ok: false; reason: string }> {
  const repositoryPath = project.remoteRepositoryPath;
  const worktreePath = `${repositoryPath}/.clawbridge-worktrees/${taskId}`;
  const branch = `clawbridge/${taskId}`;
  const withinProject = projects.allowsPath(project.id, worktreePath);
  if (!withinProject) return { ok: false, reason: "Generated worktree path is outside the worker allowlist." };
  const [repository, status] = await Promise.all([
    remoteWorker.git(worker, repositoryPath, ["rev-parse", "--is-inside-work-tree"]),
    remoteWorker.git(worker, repositoryPath, ["status", "--porcelain"]),
  ]);
  if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") return { ok: false, reason: "Registered remote repository is not a Git worktree." };
  if (status.exitCode !== 0 || status.stdout.trim()) return { ok: false, reason: "Registered remote repository has uncommitted changes; handoff is required." };
  const fetched = await remoteWorker.git(worker, repositoryPath, ["fetch", "--no-tags", "origin", project.defaultBranch]);
  if (fetched.exitCode !== 0) return { ok: false, reason: `Cannot fetch base branch: ${fetched.stderr.slice(-1_000)}` };
  const base = await remoteWorker.git(worker, repositoryPath, ["rev-parse", `origin/${project.defaultBranch}`]);
  const baseSha = base.stdout.trim();
  if (base.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(baseSha)) return { ok: false, reason: "Cannot resolve a fixed base SHA." };
  const mkdir = await remoteWorker.mkdir(worker, `${repositoryPath}/.clawbridge-worktrees`);
  if (mkdir.exitCode !== 0) return { ok: false, reason: `Cannot create worktree directory: ${mkdir.stderr.slice(-1_000)}` };
  const created = await remoteWorker.git(worker, repositoryPath, ["worktree", "add", "--detach", worktreePath, baseSha]);
  if (created.exitCode !== 0) return { ok: false, reason: `Cannot create task worktree: ${created.stderr.slice(-1_000)}` };
  const checkout = await remoteWorker.git(worker, worktreePath, ["switch", "-c", branch]);
  if (checkout.exitCode !== 0) return { ok: false, reason: `Cannot create task branch: ${checkout.stderr.slice(-1_000)}` };
  return { ok: true, worktreePath, baseSha, branch };
}
