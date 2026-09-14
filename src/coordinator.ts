import { CodeBuddyClient } from "./codebuddy-client.js";
import type { BridgeConfig } from "./config.js";
import { mapRemoteState } from "./lifecycle.js";
import { TaskStore } from "./task-store.js";
import { WebhookNotifier } from "./notifier.js";

export class Coordinator {
  private readonly notifier: WebhookNotifier | undefined;
  constructor(private readonly config: BridgeConfig, private readonly tasks: TaskStore, private readonly codeBuddy = new CodeBuddyClient(config)) {
    this.notifier = config.notificationWebhookUrl ? new WebhookNotifier(config.notificationWebhookUrl) : undefined;
  }

  async refreshOnce(): Promise<{ checked: number; changed: number }> {
    let checked = 0;
    let changed = 0;
    for (const task of this.tasks.listRecoverable()) {
      checked += 1;
      try {
        const job = await this.codeBuddy.getJob(task.remoteJobId!);
        const state = mapRemoteState(job.state, job.status, job.alive, job.settled);
        if (state !== task.executionState) changed += 1;
        this.tasks.markExecution(task.taskId, state);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown coordinator error";
        if (task.executionState !== "unknown" || task.blockReason !== reason) changed += 1;
        this.tasks.markExecution(task.taskId, "unknown", reason);
      }
    }
    if (this.notifier) {
      for (const event of this.tasks.listDeliverableEvents(20)) {
        try {
          await this.notifier.deliver(event);
          this.tasks.acknowledgeEvent(event.eventId);
        } catch {
          this.tasks.deferEvent(event.eventId);
        }
      }
    }
    return { checked, changed };
  }

  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.refreshOnce();
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
