import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CloudWorkerAgent, hasAgedPendingExecutable } from "../src/cloud-worker-agent.js";
import type { CloudTask, CloudTaskState } from "../src/cloud-task-store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import type { RemoteCommandResult } from "../src/remote-worker.js";

const TASK_ID = "123e4567-e89b-12d3-a456-426614174000";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const BRANCH = `clawbridge/${TASK_ID}`;
const WORKTREE = `/srv/projects/sample.clawbridge-worktrees/${TASK_ID}`;
type WorkerUpdateState = Exclude<CloudTaskState, "queued" | "leased">;

interface RecordedUpdate { state: WorkerUpdateState; result?: Record<string, unknown> }

function command(stdout = "", stderr = "", exitCode = 0): RemoteCommandResult {
  return { stdout, stderr, exitCode };
}

test("aged executable calls without a completion update indicate a permission wait", () => {
  const timestamp = new Date(Date.now() - 180_000).toISOString();
  assert.equal(hasAgedPendingExecutable({ updates: [
    { sessionUpdate: "tool_call", toolCallId: "call-1", status: "pending", kind: "execute", _meta: { timestamp } },
  ] }, Date.now(), 120_000), true);
  assert.equal(hasAgedPendingExecutable({ updates: [
    { sessionUpdate: "tool_call", toolCallId: "call-1", status: "pending", kind: "execute", _meta: { timestamp } },
    { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
  ] }, Date.now(), 120_000), false);
  assert.equal(hasAgedPendingExecutable({ updates: [
    { sessionUpdate: "tool_call", toolCallId: "call-2", status: "pending", kind: "read", _meta: { timestamp } },
  ] }, Date.now(), 120_000), false);
});

test("cloud Worker reports waiting_permission and resumes after the tool is approved", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-permission-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  let reads = 0;
  const codeBuddy = {
    async dispatchJob() { return { id: "job-1", state: "working" }; },
    async getJob() { reads += 1; return reads === 1 ? { id: "job-1", state: "working", alive: true } : { id: "job-1", state: "done", settled: true }; },
    async transcript() { return { updates: [
      { sessionUpdate: "tool_call", toolCallId: "call-1", status: "pending", kind: "execute", _meta: { timestamp: new Date(Date.now() - 1_000).toISOString() } },
    ] }; },
  };
  const localWorker = {
    ...healthyGit(),
    async gh(_worker: unknown, _cwd: string, args: string[]): Promise<RemoteCommandResult> {
      return args[1] === "view" ? command("https://github.com/owner/sample/pull/1\n") : command();
    },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory, "acceptEdits")),
      control: controlFor(task, updates), codeBuddy, localWorker, pollMs: 1, permissionPendingMs: 0,
    });
    assert.equal(await agent.once(), true);
    assert.deepEqual(updates.map((update) => update.state), ["running", "waiting_permission", "succeeded"]);
    assert.match(String(updates[1]?.result?.blockReason), /waiting for permission/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function writeRegistry(directory: string, permissionProfile?: "default" | "acceptEdits" | "auto" | "dontAsk"): Promise<string> {
  const registryFile = path.join(directory, "projects.json");
  await fs.writeFile(registryFile, JSON.stringify({
    schemaVersion: 1,
    workers: [{ id: "worker-a", sshHost: "local", codebuddyExecutable: "codebuddy", allowedRoots: ["/srv/projects"] }],
    projects: [{ id: "sample", repository: "owner/sample", defaultBranch: "main", workerId: "worker-a", remoteRepositoryPath: "/srv/projects/sample", ...(permissionProfile ? { permissionProfile } : {}) }],
  }));
  return registryFile;
}

function leasedTask(): CloudTask {
  return {
    taskId: TASK_ID, idempotencyKey: "cloud-worker-request-01", projectId: "sample", workerId: "worker-a",
    spec: "Add a health endpoint", specHash: "c".repeat(64), state: "leased",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    leaseOwner: "worker-a", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function controlFor(task: CloudTask, updates: RecordedUpdate[]) {
  return {
    async heartbeat() { /* no-op */ },
    async claim() { return { task, leaseMs: 60_000 }; },
    async update(_taskId: string, state: WorkerUpdateState, recorded?: Record<string, unknown>) {
      updates.push({ state, result: recorded });
      return { ...task, state, ...(recorded ? { result: recorded } : {}) };
    },
  };
}

/** A git mock where a healthy worktree is prepared, so any injected failure happens after dispatch. */
function healthyGit(overrides: { head?: RemoteCommandResult } = {}) {
  return {
    async git(_worker: unknown, _cwd: string, args: string[]): Promise<RemoteCommandResult> {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return command("true\n");
      if (args[0] === "status") return command();
      if (args[0] === "fetch") return command();
      if (args[0] === "worktree") return command();
      if (args[0] === "switch") return command();
      if (args[0] === "push") return command();
      if (args[0] === "rev-parse" && args[1] === "origin/main") return command(`${BASE_SHA}\n`);
      if (args[0] === "ls-remote") return command(`${HEAD_SHA}\trefs/heads/${BRANCH}\n`);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return overrides.head ?? command(`${HEAD_SHA}\n`);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return command(`${BRANCH}\n`);
      throw new Error(`Unexpected git command ${args.join(" ")}`);
    },
    async mkdir(): Promise<RemoteCommandResult> { return command(); },
    async gh(): Promise<RemoteCommandResult> { return command(""); },
  };
}

test("dontAsk is forwarded only when explicitly configured by the project", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-dont-ask-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  let receivedMode: string | undefined;
  const codeBuddy = {
    async dispatchJob(input: { permissionMode?: string }) {
      receivedMode = input.permissionMode;
      return { id: "job-1", state: "working" };
    },
    async getJob() { return { id: "job-1", state: "done", settled: true }; },
  };
  const localWorker = {
    ...healthyGit(),
    async gh(_worker: unknown, _cwd: string, args: string[]): Promise<RemoteCommandResult> {
      return args[1] === "view" ? command("https://github.com/owner/sample/pull/1\n") : command();
    },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory, "dontAsk")),
      control: controlFor(task, updates), codeBuddy, localWorker, pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.equal(receivedMode, "dontAsk");
    assert.equal(updates.at(-1)?.state, "succeeded");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pre-dispatch worktree failure reports failed and never dispatches", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-predispatch-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  let dispatchCount = 0;
  const localWorker = {
    async git(_worker: unknown, _cwd: string, args: string[]): Promise<RemoteCommandResult> {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return command("", "not a git tree", 1);
      if (args[0] === "status") return command();
      throw new Error(`Unexpected git command ${args.join(" ")}`);
    },
    async mkdir(): Promise<RemoteCommandResult> { return command(); },
    async gh(): Promise<RemoteCommandResult> { return command(""); },
  };
  const codeBuddy = {
    async dispatchJob() { dispatchCount += 1; return { id: "job-1" }; },
    async getJob() { throw new Error("getJob must not be called before dispatch."); },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control: controlFor(task, updates), codeBuddy, localWorker, pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.equal(dispatchCount, 0, "worktree preparation failed, so CodeBuddy must not be dispatched");
    assert.deepEqual(updates.map((update) => update.state), ["failed"]);
    assert.match(String(updates[0]?.result?.error), /not a Git worktree/i);
    assert.equal(updates[0]?.result?.remoteJobId, undefined);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("post-dispatch polling error retains the lease and retries the same job", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-polling-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  let prompt = "";
  let reads = 0;
  const codeBuddy = {
    async dispatchJob(input: { prompt: string }) { prompt = input.prompt; return { id: "job-1", state: "working" }; },
    async getJob() {
      reads += 1;
      if (reads === 1) throw new Error("CodeBuddy gateway is unreachable.");
      return { id: "job-1", state: "done", settled: true };
    },
  };
  const localWorker = {
    ...healthyGit(),
    async gh(_worker: unknown, _cwd: string, args: string[]): Promise<RemoteCommandResult> {
      return args[1] === "view" ? command("https://github.com/owner/sample/pull/1\n") : command();
    },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control: controlFor(task, updates), codeBuddy, localWorker, pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.deepEqual(updates.map((update) => update.state), ["running", "running", "succeeded"]);
    assert.match(String(updates[1]?.result?.pollWarning), /unreachable/i);
    const result = updates.at(-1)?.result;
    assert.equal(result?.remoteJobId, "job-1");
    assert.equal(result?.worktreePath, WORKTREE);
    assert.equal(result?.baseSha, BASE_SHA);
    assert.equal(result?.branch, BRANCH);
    assert.match(prompt, /at most 1 repair round/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a transient control-plane update failure does not make an accepted job unknown", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-control-retry-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  let updateAttempts = 0;
  const baseControl = controlFor(task, updates);
  const control = {
    ...baseControl,
    async update(taskId: string, state: WorkerUpdateState, recorded?: Record<string, unknown>) {
      updateAttempts += 1;
      if (updateAttempts === 1) throw new Error("control plane fetch failed");
      return baseControl.update(taskId, state, recorded);
    },
  };
  const codeBuddy = {
    async dispatchJob() { return { id: "job-1", state: "working" }; },
    async getJob() { return { id: "job-1", state: "done", settled: true }; },
  };
  const localWorker = {
    ...healthyGit(),
    async gh(_worker: unknown, _cwd: string, args: string[]): Promise<RemoteCommandResult> {
      return args[1] === "view" ? command("https://github.com/owner/sample/pull/1\n") : command();
    },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control, codeBuddy, localWorker, pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.equal(updateAttempts, 3);
    assert.deepEqual(updates.map((update) => update.state), ["running", "succeeded"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an expired runtime limit stops CodeBuddy and reports a terminal failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-timeout-"));
  const task = { ...leasedTask(), state: "running" as const, result: { remoteJobId: "job-1", worktreePath: WORKTREE, baseSha: BASE_SHA, branch: BRANCH, deadlineAt: new Date(Date.now() - 1_000).toISOString() } };
  const updates: RecordedUpdate[] = [];
  let stopped: string | undefined;
  const control = { ...controlFor(task, updates), async activeTasks() { return [task]; } };
  const codeBuddy = {
    async dispatchJob() { throw new Error("must resume instead of dispatching"); },
    async getJob() { throw new Error("expired job must be stopped before status polling"); },
    async stop(id: string) { stopped = id; return {}; },
  };
  try {
    const agent = new CloudWorkerAgent({ workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)), control, codeBuddy, localWorker: healthyGit(), pollMs: 1 });
    assert.equal(await agent.once(), true);
    assert.equal(stopped, "job-1");
    assert.equal(updates.at(-1)?.state, "failed");
    assert.match(String(updates.at(-1)?.result?.error), /runtime limit/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("post-dispatch delivery failure reports a terminal failure with job coordinates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-delivery-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  const codeBuddy = {
    async dispatchJob() { return { id: "job-1", state: "working" }; },
    async getJob() { return { id: "job-1", state: "done", settled: true }; },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control: controlFor(task, updates), codeBuddy, localWorker: healthyGit({ head: command("", "no HEAD", 1) }), pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.deepEqual(updates.map((update) => update.state), ["running", "failed"]);
    const result = updates.at(-1)?.result;
    assert.equal(result?.remoteJobId, "job-1");
    assert.equal(result?.worktreePath, WORKTREE);
    assert.equal(result?.baseSha, BASE_SHA);
    assert.equal(result?.branch, BRANCH);
    assert.match(String(result?.error), /verify task commit/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a settled CodeBuddy rate-limit result is failed without attempting delivery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-rate-limit-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  let gitCalls = 0;
  const localWorker = {
    ...healthyGit(),
    async git(...args: Parameters<ReturnType<typeof healthyGit>["git"]>) {
      gitCalls += 1;
      return healthyGit().git(...args);
    },
  };
  const codeBuddy = {
    async dispatchJob() { return { id: "job-1", state: "working" }; },
    async getJob() {
      return { id: "job-1", state: "done", settled: true, alive: true, output: { result: "429 您的使用量已超出频率限制" } };
    },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control: controlFor(task, updates), codeBuddy, localWorker, pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.deepEqual(updates.map((update) => update.state), ["running", "failed"]);
    assert.match(String(updates.at(-1)?.result?.error), /429/);
    // Worktree preparation uses six git calls; delivery must not add any.
    assert.equal(gitCalls, 6);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Worker stops the accepted CodeBuddy job when cloud cancellation is requested", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-cancel-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  let statusReads = 0;
  let stoppedJob: string | undefined;
  const control = {
    ...controlFor(task, updates),
    async workerTask() {
      statusReads += 1;
      return { ...task, state: statusReads === 1 ? "leased" as const : "cancel_requested" as const };
    },
  };
  const codeBuddy = {
    async dispatchJob() { return { id: "job-1", state: "working" }; },
    async getJob() { throw new Error("Job should be stopped before polling its result."); },
    async stop(id: string) { stoppedJob = id; return {}; },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control, codeBuddy, localWorker: healthyGit(), pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.equal(stoppedJob, "job-1");
    assert.deepEqual(updates.map((update) => update.state), ["running", "cancelled"]);
    assert.match(String(updates.at(-1)?.result?.cancellation), /stop requested/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restarted Worker resumes an accepted job instead of dispatching a second job", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-resume-"));
  const task = { ...leasedTask(), state: "running" as const, result: { remoteJobId: "job-1", worktreePath: WORKTREE, baseSha: BASE_SHA, branch: BRANCH } };
  const updates: RecordedUpdate[] = [];
  let dispatchCount = 0;
  const control = {
    ...controlFor(task, updates),
    async activeTasks() { return [task]; },
  };
  const codeBuddy = {
    async dispatchJob() { dispatchCount += 1; return { id: "job-2" }; },
    async getJob(id: string) { assert.equal(id, "job-1"); return { id, state: "done", settled: true }; },
  };
  const localWorker = {
    ...healthyGit(),
    async gh(_worker: unknown, _cwd: string, args: string[]): Promise<RemoteCommandResult> {
      return args[1] === "view" ? command("https://github.com/owner/sample/pull/1\n") : command();
    },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control, codeBuddy, localWorker, pollMs: 1,
    });
    assert.equal(await agent.once(), true);
    assert.equal(dispatchCount, 0);
    assert.deepEqual(updates.map((update) => update.state), ["succeeded"]);
    assert.equal(updates[0]?.result?.remoteJobId, "job-1");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a graceful Worker stop preserves an accepted job for later recovery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-agent-graceful-stop-"));
  const task = leasedTask();
  const updates: RecordedUpdate[] = [];
  const abort = new AbortController();
  const codeBuddy = {
    async dispatchJob() { return { id: "job-1", state: "working" }; },
    async getJob() { return { id: "job-1", state: "working", alive: true, settled: false }; },
  };
  try {
    const agent = new CloudWorkerAgent({
      workerId: "worker-a", projects: ProjectRegistry.load(await writeRegistry(directory)),
      control: controlFor(task, updates), codeBuddy, localWorker: healthyGit(), pollMs: 1_000,
    });
    setTimeout(() => abort.abort(), 5);
    assert.equal(await agent.once(abort.signal), true);
    assert.deepEqual(updates.map((update) => update.state), ["running", "running"]);
    assert.equal(updates.at(-1)?.result?.remoteJobId, "job-1");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
