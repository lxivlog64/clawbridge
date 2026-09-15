import assert from "node:assert/strict";
import test from "node:test";
import { prepareWorktree } from "../src/worktree-preparer.js";
import type { RegisteredProject, RegisteredWorker } from "../src/project-registry.js";
import type { RemoteCommandResult } from "../src/remote-worker.js";

const worker: RegisteredWorker = {
  id: "linux", sshHost: "worker", gatewayPort: 8080, codebuddyExecutable: "codebuddy",
  allowedRoots: ["/srv/projects"], capabilities: [], maxConcurrentJobs: 1,
};
const project: RegisteredProject = {
  id: "app", repository: "owner/app", deliveryRemote: "origin", defaultBranch: "main", workerId: "linux",
  remoteRepositoryPath: "/srv/projects/app", requiredCapabilities: [], testCommands: [], buildCommands: [],
  allowedTools: [],
  maxRuntimeMinutes: 120, maxRepairRounds: 1, maxConcurrentJobs: 1,
};
const success = (stdout = ""): RemoteCommandResult => ({ exitCode: 0, stdout, stderr: "" });

test("preparer fixes the base SHA and creates a dedicated worktree branch", async () => {
  const calls: string[][] = [];
  const remote = {
    async git(_worker: RegisteredWorker, _cwd: string, args: string[]) {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return success("true\n");
      if (args[0] === "status") return success();
      if (args[0] === "rev-parse") return success(`${"a".repeat(40)}\n`);
      return success();
    },
    async mkdir() { return success(); },
  };
  const result = await prepareWorktree("123e4567-e89b-12d3-a456-426614174000", project, worker, remote, () => true);
  assert.deepEqual(result, {
    ok: true, baseSha: "a".repeat(40), branch: "clawbridge/123e4567-e89b-12d3-a456-426614174000",
    worktreePath: "/srv/projects/app.clawbridge-worktrees/123e4567-e89b-12d3-a456-426614174000",
  });
  assert.ok(calls.some((args) => args[0] === "fetch"));
  assert.ok(calls.some((args) => args[0] === "worktree"));
});

test("preparer refuses a dirty source repository before creating anything", async () => {
  const remote = {
    async git(_worker: RegisteredWorker, _cwd: string, args: string[]) {
      if (args[0] === "rev-parse") return success("true\n");
      if (args[0] === "status") return success(" M important-file\n");
      throw new Error("must not fetch or create a worktree");
    },
    async mkdir() { throw new Error("must not create a directory"); },
  };
  const result = await prepareWorktree("123e4567-e89b-12d3-a456-426614174000", project, worker, remote, () => true);
  assert.deepEqual(result, { ok: false, reason: "Registered remote repository has uncommitted changes; handoff is required." });
});

test("a confirmed reconciled retry removes only a clean, uncommitted stale worktree", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const taskId = "123e4567-e89b-12d3-a456-426614174000";
  const worktreePath = `/srv/projects/app.clawbridge-worktrees/${taskId}`;
  const remote = {
    async git(_worker: RegisteredWorker, cwd: string, args: string[]) {
      calls.push({ cwd, args });
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return success("true\n");
      if (args[0] === "status") return success();
      if (args[0] === "fetch") return success();
      if (args[0] === "rev-parse" && args[1] === "origin/main") return success(`${"b".repeat(40)}\n`);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return success(`${"a".repeat(40)}\n`);
      return success();
    },
    async mkdir() { return success(); },
  };
  const result = await prepareWorktree(taskId, project, worker, remote, () => true, { priorBaseSha: "a".repeat(40) });
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.cwd === "/srv/projects/app" && call.args.join(" ") === `worktree remove ${worktreePath}`));
  assert.ok(calls.some((call) => call.cwd === "/srv/projects/app" && call.args.join(" ") === `branch -D clawbridge/${taskId}`));
});

test("a reconciled retry preserves a stale worktree with commits", async () => {
  const remote = {
    async git(_worker: RegisteredWorker, _cwd: string, args: string[]) {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return success("true\n");
      if (args[0] === "status") return success();
      if (args[0] === "fetch") return success();
      if (args[0] === "rev-parse" && args[1] === "origin/main") return success(`${"b".repeat(40)}\n`);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return success(`${"c".repeat(40)}\n`);
      throw new Error("a worktree with commits must not be removed");
    },
    async mkdir() { return success(); },
  };
  const result = await prepareWorktree("123e4567-e89b-12d3-a456-426614174000", project, worker, remote, () => true, { priorBaseSha: "a".repeat(40) });
  assert.deepEqual(result, { ok: false, reason: "Reconciled task worktree has commits beyond its original base; preserve or inspect it before retrying." });
});
