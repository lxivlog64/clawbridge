#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CloudControlClient } from "./cloud-control-client.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
if (!config.cloudControlUrl || !config.cloudApiToken) {
  throw new Error("CLAWBRIDGE_CLOUD_CONTROL_URL and CLAWBRIDGE_CLOUD_API_TOKEN are required for cloud MCP.");
}
const client = new CloudControlClient(config.cloudControlUrl, config.cloudApiToken);
const server = new McpServer({ name: "clawbridge-cloud", version: "0.1.0" });

function json(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }

server.tool(
  "clawbridge_cloud_submit",
  "Submit an idempotent development task to the cloud control plane. It queues work for the project's registered private Worker and never exposes Worker credentials to Codex.",
  {
    projectId: z.string().min(1).max(80), spec: z.string().min(1).max(200_000),
    idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/), model: z.string().min(1).max(200).optional(),
  },
  async ({ projectId, spec, idempotencyKey, model }) => json(await client.submit({ projectId, spec, idempotencyKey, model })),
);

server.tool(
  "clawbridge_cloud_tasks",
  "List compact cloud task states. Full task specifications are never returned.",
  { projectId: z.string().min(1).max(80).optional(), state: z.enum(["queued", "leased", "running", "cancel_requested", "succeeded", "failed", "cancelled", "unknown"]).optional(), limit: z.number().int().min(1).max(100).optional() },
  async (input) => json({ tasks: await client.tasks(input) }),
);

server.tool(
  "clawbridge_cloud_cancel",
  "Request cancellation of a queued or active cloud task. An active private Worker stops its CodeBuddy job and then reports cancellation.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => json({ task: await client.cancel(taskId) }),
);

server.tool(
  "clawbridge_cloud_reconcile_unknown",
  "Resolve an unknown task only after you have confirmed its remote CodeBuddy job stopped. 'close' archives it as cancelled; 'requeue' allows one new Worker attempt and can duplicate work if that confirmation is wrong.",
  { taskId: z.string().uuid(), action: z.enum(["close", "requeue"]) },
  async ({ taskId, action }) => json({ task: await client.reconcile(taskId, action) }),
);

server.tool(
  "clawbridge_cloud_status",
  "Read a cloud task's compact state, Worker assignment, and verified delivery facts. The full task specification is not returned.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = await client.task(taskId);
    if (!task) throw new Error(`Unknown cloud task ${taskId}.`);
    return json({ task });
  },
);

server.tool(
  "clawbridge_cloud_projects",
  "List the projects registered for cloud dispatch with their sanitized metadata (id, repository, branch, worker, capabilities). Local paths, credentials, allowed tools, and task specifications are never returned.",
  {},
  async () => json({ projects: await client.projects() }),
);

await server.connect(new StdioServerTransport());
