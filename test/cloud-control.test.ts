import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCloudControlServer } from "../src/cloud-control.js";
import { CloudTaskStore } from "../src/cloud-task-store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { CloudWorkerAgent } from "../src/cloud-worker-agent.js";
import type { CloudTask } from "../src/cloud-task-store.js";
import type { RemoteCommandResult } from "../src/remote-worker.js";
import { flushNotifications, WebhookNotifier } from "../src/notifier.js";
import Database from "better-sqlite3";

test("cloud state changes roll back when their outbox event cannot be written", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-atomic-outbox-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  const store = new CloudTaskStore(databaseFile);
  try {
    const task = store.createOrGet({ projectId: "sample", workerId: "worker-a", spec: "Atomic", idempotencyKey: "atomic-outbox-001" }).task;
    const blocker = new Database(databaseFile);
    blocker.exec("CREATE TRIGGER reject_event BEFORE INSERT ON cloud_task_events BEGIN SELECT RAISE(ABORT, 'event rejected'); END;");
    blocker.close();
    assert.throws(() => store.requestCancellation(task.taskId), /event rejected/);
    assert.equal(store.get(task.taskId)?.state, "queued", "state must roll back with the failed event insert");
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cloud task events are durable, acknowledged only after delivery, and back off after a failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-events-"));
  const store = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
  try {
    const { task } = store.createOrGet({ projectId: "sample", workerId: "worker-a", spec: "Write docs", idempotencyKey: "cloud-events-001" });
    const queued = store.listDeliverableEvents(10);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.taskId, task.taskId);

    let calls = 0;
    const failingFetch = (async () => { calls += 1; return new Response(null, { status: 503 }); }) as typeof fetch;
    await flushNotifications(store, new WebhookNotifier("https://notify.example/events", failingFetch));
    assert.equal(calls, 1);
    assert.equal(store.listDeliverableEvents(10).length, 0, "a failed event must wait for its retry time");

    const storeAfterRestart = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
    store.close();
    const next = storeAfterRestart.listDeliverableEvents(10);
    assert.equal(next.length, 0, "retry schedule survives a process restart");
    storeAfterRestart.acknowledgeEvent(queued[0]!.eventId);
    assert.equal(storeAfterRestart.listDeliverableEvents(10).length, 0, "acknowledged events are not delivered twice");
    storeAfterRestart.close();
  } finally {
    try { store.close(); } catch { /* already closed after restart assertion */ }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cloud claims enforce the configured per-project concurrency limit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-limits-"));
  const store = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
  try {
    const first = store.createOrGet({ projectId: "sample", workerId: "worker-a", spec: "First", idempotencyKey: "cloud-limit-first" }).task;
    const second = store.createOrGet({ projectId: "sample", workerId: "worker-a", spec: "Second", idempotencyKey: "cloud-limit-second" }).task;
    assert.equal(store.claim("worker-a", 60_000, { sample: 1 })?.taskId, first.taskId);
    assert.equal(store.claim("worker-a", 60_000, { sample: 1 }), undefined, "second task must remain queued while the project is active");
    store.updateFromWorker(first.taskId, "worker-a", "succeeded");
    const completed = store.get(first.taskId)!;
    assert.equal(completed.leaseOwner, undefined);
    assert.equal(completed.leaseExpiresAt, undefined);
    assert.throws(() => store.updateFromWorker(first.taskId, "worker-a", "running"), /does not own|cannot change/i);
    assert.equal(store.claim("worker-a", 60_000, { sample: 1 })?.taskId, second.taskId);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("two Workers run separate projects concurrently and one token can be revoked independently", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-workers-"));
  const registryFile = path.join(directory, "projects.json");
  await fs.writeFile(registryFile, JSON.stringify({ schemaVersion: 1,
    workers: [
      { id: "worker-a", sshHost: "unused", codebuddyExecutable: "codebuddy", allowedRoots: ["/srv/a"] },
      { id: "worker-b", sshHost: "unused", codebuddyExecutable: "codebuddy", allowedRoots: ["/srv/b"] },
    ],
    projects: [
      { id: "project-a", repository: "owner/a", defaultBranch: "main", workerId: "worker-a", remoteRepositoryPath: "/srv/a/repo" },
      { id: "project-b", repository: "owner/b", defaultBranch: "main", workerId: "worker-b", remoteRepositoryPath: "/srv/b/repo" },
    ],
  }));
  const store = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
  const clientToken = "client-token-which-is-long-enough";
  const tokens = { "worker-a": "worker-a-token-which-is-long-enough", "worker-b": "worker-b-token-which-is-long-enough" };
  let server = createCloudControlServer({ apiToken: clientToken, workerTokens: tokens, projects: ProjectRegistry.load(registryFile), tasks: store });
  let origin = await listen(server);
  try {
    for (const projectId of ["project-a", "project-b"]) {
      const response = await fetch(`${origin}/v1/tasks`, { method: "POST", headers: auth(clientToken), body: JSON.stringify({ projectId, spec: "isolated test", idempotencyKey: `multi-worker-${projectId}` }) });
      assert.equal(response.status, 201);
    }
    const a = await json(await fetch(`${origin}/v1/workers/worker-a/claim`, { method: "POST", headers: auth(tokens["worker-a"]!), body: "{}" }));
    const b = await json(await fetch(`${origin}/v1/workers/worker-b/claim`, { method: "POST", headers: auth(tokens["worker-b"]!), body: "{}" }));
    assert.equal(a.task.projectId, "project-a");
    assert.equal(b.task.projectId, "project-b");
    const crossWorker = await fetch(`${origin}/v1/workers/worker-b/claim`, { method: "POST", headers: auth(tokens["worker-a"]!), body: "{}" });
    assert.equal(crossWorker.status, 401);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createCloudControlServer({ apiToken: clientToken, workerTokens: { "worker-b": tokens["worker-b"]! }, projects: ProjectRegistry.load(registryFile), tasks: store });
    origin = await listen(server);
    const revoked = await fetch(`${origin}/v1/workers/worker-a/heartbeat`, { method: "POST", headers: auth(tokens["worker-a"]!), body: "{}" });
    const stillActive = await fetch(`${origin}/v1/workers/worker-b/heartbeat`, { method: "POST", headers: auth(tokens["worker-b"]!), body: "{}" });
    assert.equal(revoked.status, 401);
    assert.equal(stillActive.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cloud control authenticates clients and leases a task only to its registered worker", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-control-"));
  const registryFile = path.join(directory, "projects.json");
  await fs.writeFile(registryFile, JSON.stringify({
    schemaVersion: 1,
    workers: [{ id: "worker-a", sshHost: "unused", codebuddyExecutable: "codebuddy", allowedRoots: ["/srv/projects"] }],
    projects: [{ id: "sample", repository: "owner/sample", defaultBranch: "main", workerId: "worker-a", remoteRepositoryPath: "/srv/projects/sample" }],
  }));
  const store = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
  const server = createCloudControlServer({
    apiToken: "client-token-which-is-long-enough", workerTokens: { "worker-a": "worker-token-which-is-long-enough" },
    projects: ProjectRegistry.load(registryFile), tasks: store, leaseMs: 60_000,
  });
  const origin = await listen(server);
  try {
    const denied = await fetch(`${origin}/v1/tasks`, { method: "POST" });
    assert.equal(denied.status, 401);

    const projectsDenied = await fetch(`${origin}/v1/projects`);
    assert.equal(projectsDenied.status, 401);
    const projectsWrong = await fetch(`${origin}/v1/projects`, { headers: auth("wrong-token-which-is-long-enough") });
    assert.equal(projectsWrong.status, 401);

    const projectsResponse = await fetch(`${origin}/v1/projects`, { headers: auth("client-token-which-is-long-enough") });
    assert.equal(projectsResponse.status, 200);
    const listed = await json(projectsResponse);
    assert.equal(listed.projects.length, 1);
    const project = listed.projects[0];
    assert.equal(project.id, "sample");
    assert.equal(project.repository, "owner/sample");
    assert.equal(project.defaultBranch, "main");
    assert.equal(project.workerId, "worker-a");
    assert.equal("remoteRepositoryPath" in project, false);
    assert.equal("allowedTools" in project, false);
    assert.equal("githubCredentialRef" in project, false);
    assert.equal("testCommands" in project, false);
    assert.equal("spec" in project, false);

    const projectsRaw = await (await fetch(`${origin}/v1/projects`, { headers: auth("client-token-which-is-long-enough") })).text();
    assert.equal(projectsRaw.includes("/srv/projects"), false);
    assert.equal(projectsRaw.includes("client-token"), false);
    assert.equal(projectsRaw.includes("worker-token"), false);

    const created = await json(await fetch(`${origin}/v1/tasks`, {
      method: "POST", headers: auth("client-token-which-is-long-enough"),
      body: JSON.stringify({ projectId: "sample", spec: "Add a health endpoint", idempotencyKey: "cloud-request-0001", model: "hy4-preview" }),
    }));
    assert.equal(created.reused, false);
    assert.equal(created.task.state, "queued");
    assert.equal("spec" in created.task, false);

    const heart = await json(await fetch(`${origin}/v1/workers/worker-a/heartbeat`, {
      method: "POST", headers: auth("worker-token-which-is-long-enough"), body: JSON.stringify({ metadata: { version: "0.1.0" } }),
    }));
    assert.equal(heart.worker.workerId, "worker-a");

    const claimed = await json(await fetch(`${origin}/v1/workers/worker-a/claim`, { method: "POST", headers: auth("worker-token-which-is-long-enough") }));
    assert.equal(claimed.task.state, "leased");
    assert.equal(claimed.task.spec, "Add a health endpoint");

    const updated = await json(await fetch(`${origin}/v1/tasks/${created.task.taskId}/events`, {
      method: "POST", headers: auth("worker-token-which-is-long-enough"), body: JSON.stringify({ state: "succeeded", result: { commitSha: "a".repeat(40) } }),
    }));
    assert.equal(updated.task.state, "succeeded");

    const status = await json(await fetch(`${origin}/v1/tasks/${created.task.taskId}`, { headers: auth("client-token-which-is-long-enough") }));
    assert.equal(status.task.state, "succeeded");
    assert.equal(status.task.result.commitSha, "a".repeat(40));
    assert.equal("spec" in status.task, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cloud MCP publishes submit, status, and read-only projects tools", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-mcp-"));
  const registryFile = path.join(directory, "projects.json");
  await fs.writeFile(registryFile, JSON.stringify({
    schemaVersion: 1,
    workers: [{ id: "worker-a", sshHost: "unused", codebuddyExecutable: "codebuddy", allowedRoots: ["/srv/projects"] }],
    projects: [{ id: "sample", repository: "owner/sample", defaultBranch: "main", workerId: "worker-a", remoteRepositoryPath: "/srv/projects/sample", allowedTools: ["Bash(npm test)"] }],
  }));
  const store = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
  const token = "cloud-mcp-client-token-long-enough";
  const server = createCloudControlServer({ apiToken: token, workerTokens: {}, projects: ProjectRegistry.load(registryFile), tasks: store });
  const origin = await listen(server);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve("dist/src/cloud-mcp.js")],
    env: { PATH: process.env.PATH ?? "", CLAWBRIDGE_CLOUD_CONTROL_URL: origin, CLAWBRIDGE_CLOUD_API_TOKEN: token, CLAWBRIDGE_STATE_DIR: path.join(directory, "state") },
  });
  const client = new Client({ name: "cloud-mcp-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "clawbridge_cloud_cancel", "clawbridge_cloud_projects", "clawbridge_cloud_reconcile_unknown",
      "clawbridge_cloud_review_record", "clawbridge_cloud_review_status", "clawbridge_cloud_status", "clawbridge_cloud_submit", "clawbridge_cloud_tasks",
    ]);

    const result = await client.callTool({ name: "clawbridge_cloud_projects", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text);
    assert.equal(payload.projects.length, 1);
    assert.equal(payload.projects[0].id, "sample");
    assert.equal(payload.projects[0].repository, "owner/sample");
    assert.equal("remoteRepositoryPath" in payload.projects[0], false);
    assert.equal("allowedTools" in payload.projects[0], false);
    assert.equal(text.includes("/srv/projects"), false);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a review is bound to its delivery SHA and becomes stale when a PR head changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-review-"));
  const store = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
  const firstHead = "a".repeat(40);
  const secondHead = "b".repeat(40);
  try {
    const task = store.createOrGet({ projectId: "sample", workerId: "worker-a", spec: "Review me", idempotencyKey: "cloud-review-001" }).task;
    store.claim("worker-a", 60_000);
    store.updateFromWorker(task.taskId, "worker-a", "succeeded", { headSha: firstHead, prUrl: "https://github.com/owner/sample/pull/1" });
    const reviewed = store.recordReview(task.taskId, { conclusion: "approved", comment: "Looks good", reviewedHeadSha: firstHead });
    assert.equal(reviewed.review?.status, "current");
    assert.equal(reviewed.review?.conclusion, "approved");
    const stale = store.observeReviewHead(task.taskId, secondHead);
    assert.equal(stale.review?.status, "stale");
    assert.equal(stale.review?.observedHeadSha, secondHead);
    assert.equal(store.listDeliverableEvents(100).filter((event) => event.kind === "task.review_stale").length, 1);
    store.observeReviewHead(task.taskId, secondHead);
    assert.equal(store.listDeliverableEvents(100).filter((event) => event.kind === "task.review_stale").length, 1, "rechecking the same stale review must not emit another notification");
    assert.throws(() => store.recordReview(task.taskId, { conclusion: "approved", reviewedHeadSha: secondHead }), /current delivery SHA/i);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cloud control lists tasks, coordinates cancellation, and requires an explicit unknown reconciliation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-reconcile-"));
  const registryFile = path.join(directory, "projects.json");
  await fs.writeFile(registryFile, JSON.stringify({
    schemaVersion: 1,
    workers: [{ id: "worker-a", sshHost: "unused", codebuddyExecutable: "codebuddy", allowedRoots: ["/srv/projects"] }],
    projects: [{ id: "sample", repository: "owner/sample", defaultBranch: "main", workerId: "worker-a", remoteRepositoryPath: "/srv/projects/sample" }],
  }));
  const token = "client-token-which-is-long-enough";
  const workerToken = "worker-token-which-is-long-enough";
  const store = new CloudTaskStore(path.join(directory, "cloud.sqlite"));
  const server = createCloudControlServer({ apiToken: token, workerTokens: { "worker-a": workerToken }, projects: ProjectRegistry.load(registryFile), tasks: store, leaseMs: 60_000 });
  const origin = await listen(server);
  const create = async (key: string) => json(await fetch(`${origin}/v1/tasks`, { method: "POST", headers: auth(token), body: JSON.stringify({ projectId: "sample", spec: `Work ${key}`, idempotencyKey: key }) }));
  try {
    const queued = await create("cloud-reconcile-queued-01");
    const listed = await json(await fetch(`${origin}/v1/tasks?state=queued&limit=10`, { headers: auth(token) }));
    assert.equal(listed.tasks.length, 1);
    assert.equal("spec" in listed.tasks[0], false);
    const cancelled = await json(await fetch(`${origin}/v1/tasks/${queued.task.taskId}/cancel`, { method: "POST", headers: auth(token), body: "{}" }));
    assert.equal(cancelled.task.state, "cancelled");

    const active = await create("cloud-reconcile-active-01");
    const claimed = await json(await fetch(`${origin}/v1/workers/worker-a/claim`, { method: "POST", headers: auth(workerToken), body: "{}" }));
    assert.equal(claimed.task.taskId, active.task.taskId);
    const requested = await json(await fetch(`${origin}/v1/tasks/${active.task.taskId}/cancel`, { method: "POST", headers: auth(token), body: "{}" }));
    assert.equal(requested.task.state, "cancel_requested");
    const workerView = await json(await fetch(`${origin}/v1/workers/worker-a/tasks/${active.task.taskId}`, { headers: auth(workerToken) }));
    assert.equal(workerView.task.state, "cancel_requested");
    const activeView = await json(await fetch(`${origin}/v1/workers/worker-a/active`, { headers: auth(workerToken) }));
    assert.equal(activeView.tasks.length, 1);
    assert.equal(activeView.tasks[0].taskId, active.task.taskId);
    assert.equal("spec" in activeView.tasks[0], false);
    const workerCancelled = await json(await fetch(`${origin}/v1/tasks/${active.task.taskId}/events`, { method: "POST", headers: auth(workerToken), body: JSON.stringify({ state: "cancelled", result: { cancellation: "stopped" } }) }));
    assert.equal(workerCancelled.task.state, "cancelled");

    const uncertain = await create("cloud-reconcile-unknown-01");
    await json(await fetch(`${origin}/v1/workers/worker-a/claim`, { method: "POST", headers: auth(workerToken), body: "{}" }));
    await json(await fetch(`${origin}/v1/tasks/${uncertain.task.taskId}/events`, { method: "POST", headers: auth(workerToken), body: JSON.stringify({ state: "unknown", result: { remoteJobId: "job-1" } }) }));
    const unconfirmed = await fetch(`${origin}/v1/tasks/${uncertain.task.taskId}/reconcile`, { method: "POST", headers: auth(token), body: JSON.stringify({ action: "requeue" }) });
    assert.equal(unconfirmed.status, 400);
    const requeued = await json(await fetch(`${origin}/v1/tasks/${uncertain.task.taskId}/reconcile`, { method: "POST", headers: auth(token), body: JSON.stringify({ action: "requeue", remoteJobConfirmedStopped: true }) }));
    assert.equal(requeued.task.state, "queued");
    assert.equal(requeued.task.result.reconciliation.action, "requeue");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("private cloud worker creates a worktree, runs CodeBuddy, and reports a draft PR", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-cloud-worker-"));
  const registryFile = path.join(directory, "projects.json");
  await fs.writeFile(registryFile, JSON.stringify({
    schemaVersion: 1,
    workers: [{ id: "worker-a", sshHost: "local", codebuddyExecutable: "codebuddy", allowedRoots: ["/srv/projects"] }],
    projects: [{ id: "sample", repository: "owner/sample", defaultBranch: "main", workerId: "worker-a", remoteRepositoryPath: "/srv/projects/sample" }],
  }));
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const task: CloudTask = {
    taskId: "123e4567-e89b-12d3-a456-426614174000", idempotencyKey: "cloud-worker-request-01", projectId: "sample", workerId: "worker-a",
    spec: "Add a health endpoint", specHash: "c".repeat(64), requestedModel: "deepseek-v4.1-flash", state: "leased", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), leaseOwner: "worker-a", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const updates: Array<{ state: string; result?: Record<string, unknown> }> = [];
  const control = {
    async heartbeat() {}, async claim() { return { task, leaseMs: 60_000 }; },
    async update(_id: string, state: any, result?: Record<string, unknown>) { updates.push({ state, result }); return { ...task, state, ...(result ? { result } : {}) }; },
  };
  const result = (stdout = "", stderr = "", exitCode = 0): RemoteCommandResult => ({ stdout, stderr, exitCode });
  const localWorker = {
    async git(_worker: unknown, _cwd: string, args: string[]) {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return result("true\n");
      if (args[0] === "status") return result();
      if (args[0] === "fetch" || args[0] === "worktree" || args[0] === "switch" || args[0] === "push") return result();
      if (args[0] === "rev-parse" && args[1] === "origin/main") return result(`${baseSha}\n`);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return result(`${headSha}\n`);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return result(`clawbridge/${task.taskId}\n`);
      if (args[0] === "ls-remote") return result(`${headSha}\trefs/heads/clawbridge/${task.taskId}\n`);
      throw new Error(`Unexpected git command ${args.join(" ")}`);
    },
    async mkdir() { return result(); },
    async gh(_worker: unknown, _cwd: string, args: string[]) { return args[1] === "view" ? result("", "not found", 1) : result("https://github.com/owner/sample/pull/1\n"); },
  };
  const codeBuddy = { async dispatchJob() { return { id: "job-1", state: "working", model: "deepseek-v4.1-flash" }; }, async getJob() { return { id: "job-1", state: "done", settled: true, model: "deepseek-v4.1-flash", usage: { inputTokens: 120, outputTokens: 34 } }; } };
  try {
    const agent = new CloudWorkerAgent({ workerId: "worker-a", projects: ProjectRegistry.load(registryFile), control, codeBuddy, localWorker, pollMs: 1 });
    assert.equal(await agent.once(), true);
    assert.equal(updates[0]?.state, "running");
    assert.equal(updates.at(-1)?.state, "succeeded");
    assert.equal(updates.at(-1)?.result?.headSha, headSha);
    assert.equal(updates.at(-1)?.result?.prUrl, "https://github.com/owner/sample/pull/1");
    const usage = updates.at(-1)?.result?.usage as Record<string, unknown>;
    assert.equal(usage.requestedModel, "deepseek-v4.1-flash");
    assert.equal(usage.observedModel, "deepseek-v4.1-flash");
    assert.equal(typeof usage.durationMs, "number");
    assert.equal(usage.inputTokens, 120);
    assert.equal(usage.outputTokens, 34);
    assert.equal(usage.credits, "unknown");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

function auth(token: string): Record<string, string> { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }
async function json(response: Response): Promise<any> {
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}
async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
