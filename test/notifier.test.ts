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
    eventId: "event-1", taskId: "task-1", kind: "task.state_changed", summary: "running → succeeded", createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(captured?.method, "POST");
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    eventId: "event-1", taskId: "task-1", kind: "task.state_changed", summary: "running → succeeded", createdAt: "2026-01-01T00:00:00.000Z",
  });
});

test("Server酱 notifier uses form fields and never puts task data in the URL", async () => {
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    captured = init;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const { serverChanNotifier } = await import("../src/notifier.js");
  await serverChanNotifier("SCT1234567890", fetchFn).deliver({ eventId: "event-2", taskId: "task-2", kind: "task.state_changed", summary: "queued → succeeded", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.match(capturedUrl, /\.send$/);
  assert.equal(capturedUrl.includes("task-2"), false);
  assert.equal(captured?.headers && (captured.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  const fields = new URLSearchParams(String(captured?.body));
  assert.match(fields.get("title") ?? "", /queued → succeeded/);
  assert.match(fields.get("desp") ?? "", /任务：task-2/);
});
