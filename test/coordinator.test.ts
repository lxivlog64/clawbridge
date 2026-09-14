import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CodeBuddyClient } from "../src/codebuddy-client.js";
import { Coordinator } from "../src/coordinator.js";
import type { BridgeConfig } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";

test("coordinator persists a remote terminal state and emits an event", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-coordinator-"));
  const tasks = new TaskStore(path.join(directory, "tasks.sqlite"));
  const created = tasks.createOrGet({ projectId: "app", spec: "test", idempotencyKey: "coordinator-0001" }).task;
  tasks.markDispatched(created.taskId, "remote-1");
  const config = { coordinatorPollMs: 1 } as BridgeConfig;
  const codeBuddy = { getJob: async () => ({ id: "remote-1", state: "done", settled: true }) } as unknown as CodeBuddyClient;
  const result = await new Coordinator(config, tasks, codeBuddy).refreshOnce();
  assert.deepEqual(result, { checked: 1, changed: 1 });
  assert.equal(tasks.get(created.taskId)?.executionState, "succeeded");
  assert.ok(tasks.listEvents(10).some((event) => event.kind === "task.state_changed"));
  tasks.close();
  await fs.rm(directory, { recursive: true, force: true });
});
