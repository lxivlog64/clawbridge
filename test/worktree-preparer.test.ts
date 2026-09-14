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
