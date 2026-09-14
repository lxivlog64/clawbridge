import assert from "node:assert/strict";
import test from "node:test";
import { WebhookNotifier } from "../src/notifier.js";

test("webhook notifier sends only compact event fields", async () => {
  let captured: RequestInit | undefined;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = init;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await new WebhookNotifier("https://notify.example/events", fetchFn).deliver({
    eventId: "event-1", taskId: "task-1", kind: "task.state_changed", summary: "running → succeeded", createdAt: "2026-01-01T00:00:00.000Z", attempts: 0,
  });
  assert.equal(captured?.method, "POST");
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    eventId: "event-1", taskId: "task-1", kind: "task.state_changed", summary: "running → succeeded", createdAt: "2026-01-01T00:00:00.000Z",
  });
});
