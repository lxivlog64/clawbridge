import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/task-store.js";

test("task store persists queued work and deduplicates identical requests", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-task-store-"));
  const databaseFile = path.join(directory, "tasks.sqlite");
  const firstStore = new TaskStore(databaseFile);
  const first = firstStore.createOrGet({
    projectId: "sample-app", spec: "Implement the profile page", idempotencyKey: "request-0001",
  });
  const repeated = firstStore.createOrGet({
    projectId: "sample-app", spec: "Implement the profile page", idempotencyKey: "request-0001",
  });
  assert.equal(first.reused, false);
  assert.equal(firstStore.listEvents(10).length, 1);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.task.taskId, first.task.taskId);
  firstStore.close();

  const secondStore = new TaskStore(databaseFile);
  assert.deepEqual(secondStore.get(first.task.taskId), first.task);
  assert.equal(secondStore.getSpec(first.task.taskId), "Implement the profile page");
  const dispatched = secondStore.markDispatched(first.task.taskId, "remote-job-1");
  assert.equal(dispatched.executionState, "running");
  assert.equal(dispatched.remoteJobId, "remote-job-1");
  assert.equal(secondStore.activeCount("sample-app"), 1);
  assert.equal(secondStore.markExecution(first.task.taskId, "cancel_requested").executionState, "cancel_requested");
  const prepared = secondStore.markPrepared(first.task.taskId, "/srv/projects/sample/.clawbridge-worktrees/task", "b".repeat(40), "clawbridge/task");
  assert.equal(prepared.baseSha, "b".repeat(40));
  assert.equal(prepared.branch, "clawbridge/task");
  const verified = secondStore.markVerified(first.task.taskId, "/srv/projects/sample/.worktrees/task", "a".repeat(40));
  assert.equal(verified.headSha, "a".repeat(40));
  assert.equal(secondStore.markDelivery(first.task.taskId, "ready", { prUrl: "https://example.test/pr/1" }).prUrl, "https://example.test/pr/1");
  const event = secondStore.listEvents(10, true)[0];
  assert.ok(event);
  assert.equal(secondStore.acknowledgeEvent(event!.eventId), true);
  assert.equal(secondStore.list({ limit: 10 }).length, 1);
  assert.throws(() => secondStore.createOrGet({
    projectId: "sample-app", spec: "A different request", idempotencyKey: "request-0001",
  }), /different task input/);
  secondStore.close();
  await fs.rm(directory, { recursive: true, force: true });
});
