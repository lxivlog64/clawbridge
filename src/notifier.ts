export interface NotificationEvent { eventId: string; taskId: string; kind: string; summary: string; createdAt: string; }
export interface NotificationOutbox { listDeliverableEvents(limit: number): NotificationEvent[]; acknowledgeEvent(eventId: string): boolean; deferEvent(eventId: string): void; }

export type NotificationProvider = "webhook" | "serverchan";

export class WebhookNotifier {
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly provider: NotificationProvider = "webhook",
  ) {}

  async deliver(event: NotificationEvent): Promise<void> {
    const serverChan = this.provider === "serverchan";
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": serverChan ? "application/x-www-form-urlencoded" : "application/json" },
      body: serverChan
        ? new URLSearchParams({ title: `ClawBridge：${event.summary}`, desp: `任务：${event.taskId}\n事件：${event.kind}\n时间：${event.createdAt}\n事件 ID：${event.eventId}` }).toString()
        : JSON.stringify({ eventId: event.eventId, taskId: event.taskId, kind: event.kind, summary: event.summary, createdAt: event.createdAt }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Notification webhook failed (${response.status}).`);
  }
}

/** Builds Server酱's endpoint locally; callers never place this secret in task data. */
export function serverChanNotifier(sendKey: string, fetchFn: typeof fetch = fetch): WebhookNotifier {
  if (!/^SCT[A-Za-z0-9]+$/.test(sendKey)) throw new Error("CLAWBRIDGE_CLOUD_SERVERCHAN_SENDKEY is invalid.");
  return new WebhookNotifier(`https://sctapi.ftqq.com/${sendKey}.send`, fetchFn, "serverchan");
}

export async function flushNotifications(outbox: NotificationOutbox, notifier: WebhookNotifier, limit = 20): Promise<void> {
  for (const event of outbox.listDeliverableEvents(limit)) {
    try { await notifier.deliver(event); outbox.acknowledgeEvent(event.eventId); }
    catch { outbox.deferEvent(event.eventId); }
  }
}
