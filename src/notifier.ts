import type { TaskEvent } from "./task-store.js";

export class WebhookNotifier {
  constructor(private readonly url: string, private readonly fetchFn: typeof fetch = fetch) {}

  async deliver(event: TaskEvent): Promise<void> {
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: event.eventId, taskId: event.taskId, kind: event.kind, summary: event.summary, createdAt: event.createdAt }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Notification webhook failed (${response.status}).`);
  }
}
