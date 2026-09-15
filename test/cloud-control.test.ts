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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["clawbridge_cloud_projects", "clawbridge_cloud_status", "clawbridge_cloud_submit"]);

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
    spec: "Add a health endpoint", specHash: "c".repeat(64), state: "leased", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), leaseOwner: "worker-a", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
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
  const codeBuddy = { async dispatchJob() { return { id: "job-1", state: "working" }; }, async getJob() { return { id: "job-1", state: "done", settled: true }; } };
  try {
    const agent = new CloudWorkerAgent({ workerId: "worker-a", projects: ProjectRegistry.load(registryFile), control, codeBuddy, localWorker, pollMs: 1 });
    assert.equal(await agent.once(), true);
    assert.equal(updates[0]?.state, "running");
    assert.equal(updates.at(-1)?.state, "succeeded");
    assert.equal(updates.at(-1)?.result?.headSha, headSha);
    assert.equal(updates.at(-1)?.result?.prUrl, "https://github.com/owner/sample/pull/1");
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
