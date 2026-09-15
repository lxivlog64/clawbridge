#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { WorkBuddyOAuth } from "./oauth.js";
import { TokenStore } from "./token-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskStore } from "./task-store.js";
import { Coordinator } from "./coordinator.js";
import { CloudTaskStore } from "./cloud-task-store.js";
import { createCloudControlServer } from "./cloud-control.js";
import { CloudControlClient } from "./cloud-control-client.js";
import { CloudWorkerAgent } from "./cloud-worker-agent.js";
import { CodeBuddyClient } from "./codebuddy-client.js";
import { flushNotifications, serverChanNotifier, WebhookNotifier } from "./notifier.js";

const config = loadConfig();
const store = new TokenStore(config.tokenFile);
const client = new WorkBuddyClient(config, store);
const oauth = new WorkBuddyOAuth(config, store);
const projects = ProjectRegistry.load(config.projectsFile);
const tasks = new TaskStore(config.taskDatabaseFile);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "auth": {
      const token = await oauth.authenticateInteractively(!args.includes("--no-open"));
      console.log(JSON.stringify({ authorized: true, scope: token.scope, openId: token.openId }, null, 2));
      return;
    }
    case "status":
      console.log(JSON.stringify({ online: await client.online() }, null, 2));
      return;
    case "send": {
      const content = args.join(" ").trim();
      if (!content) throw new Error("Usage: workbuddy-bridge send <message>");
      console.log(JSON.stringify({ messageId: await client.sendMessage(content) }, null, 2));
      return;
    }
    case "history": {
      console.log(JSON.stringify({ messages: await client.history({ limit: 20 }) }, null, 2));
      return;
    }
    case "projects":
      console.log(JSON.stringify({ projects: projects.list(), registryFile: config.projectsFile }, null, 2));
      return;
    case "tasks":
      console.log(JSON.stringify({ tasks: tasks.list({ limit: 20 }) }, null, 2));
      return;
    case "coordinator": {
      const coordinator = new Coordinator(config, tasks);
      if (args.includes("--once")) {
        console.log(JSON.stringify(await coordinator.refreshOnce(), null, 2));
        return;
      }
      const abort = new AbortController();
      process.once("SIGINT", () => abort.abort());
      process.once("SIGTERM", () => abort.abort());
      await coordinator.run(config.coordinatorPollMs, abort.signal);
      return;
    }
    case "cloud-server": {
      const cloudTasks = new CloudTaskStore(config.cloudDatabaseFile);
      const server = createCloudControlServer({ apiToken: config.cloudApiToken, workerTokens: config.cloudWorkerTokens, projects, tasks: cloudTasks });
      await new Promise<void>((resolve) => server.listen(config.cloudPort, config.cloudListenHost, resolve));
      console.log(JSON.stringify({ listening: `${config.cloudListenHost}:${config.cloudPort}` }));
      const notifier = config.cloudServerChanSendKey ? serverChanNotifier(config.cloudServerChanSendKey)
        : config.cloudNotificationWebhookUrl ? new WebhookNotifier(config.cloudNotificationWebhookUrl) : undefined;
      let flushing = false;
      const flush = async () => {
        if (!notifier || flushing) return;
        flushing = true;
        try { await flushNotifications(cloudTasks, notifier); } finally { flushing = false; }
      };
      void flush();
      const notificationTimer = notifier ? setInterval(() => { void flush(); }, config.coordinatorPollMs) : undefined;
      const close = () => {
        if (notificationTimer) clearInterval(notificationTimer);
        server.close(() => { cloudTasks.close(); process.exit(0); });
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      return;
    }
    case "cloud-worker": {
      if (!config.cloudControlUrl || !config.cloudWorkerId || !config.cloudWorkerToken) {
        throw new Error("CLAWBRIDGE_CLOUD_CONTROL_URL, CLAWBRIDGE_CLOUD_WORKER_ID, and CLAWBRIDGE_CLOUD_WORKER_TOKEN are required for cloud-worker.");
      }
      const agent = new CloudWorkerAgent({
        workerId: config.cloudWorkerId, projects,
        control: new CloudControlClient(config.cloudControlUrl, config.cloudWorkerToken),
        codeBuddy: new CodeBuddyClient(config), pollMs: config.cloudWorkerPollMs,
      });
      if (args.includes("--once")) {
        console.log(JSON.stringify({ claimed: await agent.once() }, null, 2));
        return;
      }
      const abort = new AbortController();
      process.once("SIGINT", () => abort.abort());
      process.once("SIGTERM", () => abort.abort());
      await agent.run(abort.signal);
      return;
    }
    default:
      console.log(`workbuddy-bridge commands:
  auth [--no-open]   Authorize through a loopback OAuth callback
  status             Check whether the PC local assistant is online
  send <message>     Send a plain-text instruction
  history            Read the 20 most recent messages
  projects           List registered ClawBridge projects
  tasks              List the 20 most recent durable ClawBridge tasks
  coordinator [--once]  Refresh remote task states and write local events
  cloud-server       Start the authenticated cloud control API
  cloud-worker [--once]  Claim and execute private Worker tasks from cloud control`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
