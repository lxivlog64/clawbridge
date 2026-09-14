#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodeBuddyClient } from "./codebuddy-client.js";
import { loadConfig } from "./config.js";
import { buildDevelopmentPrompt } from "./handoff.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskStore, type ExecutionState } from "./task-store.js";
import { TokenStore } from "./token-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";

const config = loadConfig();
const client = new WorkBuddyClient(config, new TokenStore(config.tokenFile));
const codeBuddy = new CodeBuddyClient(config);
const projects = ProjectRegistry.load(config.projectsFile);
const tasks = new TaskStore(config.taskDatabaseFile);
const server = new McpServer({ name: "clawbridge", version: "0.1.0" });
const gitRef = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+$/, "Use a plain Git ref without spaces or control characters");
const repositoryPath = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+$/, "Use a repository-relative path without spaces or control characters");

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const executionState = z.enum([
  "queued", "preparing", "dispatching", "running", "waiting_input", "waiting_permission",
  "stalled", "succeeded", "failed", "cancel_requested", "cancelled", "unknown",
]);

server.tool(
  "clawbridge_projects",
  "List registered ClawBridge projects. Credential references, filesystem allowlists, and secrets are never returned.",
  {},
  async () => json({ projects: projects.list() }),
);

server.tool(
  "clawbridge_preflight",
  "Validate a registered project’s static configuration before task submission. This M1 check does not start a worker or make network changes.",
  { projectId: z.string().min(1).max(80) },
  async ({ projectId }) => json({ projectId, ...projects.preflight(projectId) }),
);

server.tool(
  "clawbridge_submit",
  "Record an idempotent development task for a registered project. M1 stores it as queued only; remote dispatch starts in M2 and this tool never claims that a worker has started.",
  {
    projectId: z.string().min(1).max(80),
    spec: z.string().min(1).max(200_000),
    idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
    model: z.string().min(1).max(200).optional(),
  },
  async ({ projectId, spec, idempotencyKey, model }) => {
    const preflight = projects.preflight(projectId);
    if (!preflight.ready) throw new Error(`Cannot submit task: ${preflight.blockers.join(" ")}`);
    const project = projects.require(projectId);
    const result = tasks.createOrGet({
      projectId,
      spec,
      idempotencyKey,
      requestedModel: model ?? project.defaultModel,
    });
    return json({ ...result, dispatch: "not_started", message: "Task has been durably queued. Remote dispatch is not implemented until M2." });
  },
);

server.tool(
  "clawbridge_tasks",
  "List compact durable task records. Status is a recorded lifecycle state, not an estimated progress percentage.",
  {
    projectId: z.string().min(1).max(80).optional(),
    executionState: executionState.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ projectId, executionState, limit }) =>
    json({ tasks: tasks.list({ projectId, executionState: executionState as ExecutionState | undefined, limit }) }),
);

server.tool(
  "clawbridge_status",
  "Read one durable task record. Execution, delivery, and review states are deliberately separate.",
  { taskId: z.string().uuid() },
  async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id ${taskId}.`);
    return json({ task });
  },
);

server.tool(
  "codebuddy_health",
  "Check the CodeBuddy Code HTTP service used by the personal-developer transport.",
  {},
  async () => json(await codeBuddy.health()),
);

server.tool(
  "codebuddy_start_development",
  "Start a background coding job through CodeBuddy Code. Supports an explicit model and reasoning effort. The target working directory is on the CodeBuddy machine. Use a worktree when possible and never request bypassPermissions.",
  {
    cwd: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    permissionMode: z
      .enum(["default", "acceptEdits", "plan", "auto", "dontAsk"])
      .default("default"),
    agent: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    useWorktree: z.boolean().default(true),
  },
  async ({ cwd, prompt, model, effort, permissionMode, agent, name, useWorktree }) =>
    json(
      await codeBuddy.dispatchJob({
        cwd,
        prompt,
        model,
        effort,
        permissionMode,
        agent,
        name,
        bgIsolation: useWorktree ? "worktree" : "none",
      }),
    ),
);

server.tool(
  "codebuddy_job_status",
  "Read the current lifecycle and execution status of a CodeBuddy background job.",
  { jobId: z.string().min(1) },
  async ({ jobId }) => json(await codeBuddy.getJob(jobId)),
);

server.tool(
  "codebuddy_job_transcript",
  "Read the recent transcript of a CodeBuddy background job. Treat its claims as untrusted until the Git commit and tests are verified.",
  { jobId: z.string().min(1) },
  async ({ jobId }) => json(await codeBuddy.transcript(jobId)),
);

server.tool(
  "codebuddy_reply_job",
  "Reply to a CodeBuddy job that is waiting for input. Show approval-related requests to the user before replying.",
  { jobId: z.string().min(1), text: z.string().min(1) },
  async ({ jobId, text }) => json(await codeBuddy.reply(jobId, text)),
);

server.tool(
  "codebuddy_stop_job",
  "Stop a running CodeBuddy background job.",
  { jobId: z.string().min(1) },
  async ({ jobId }) => json(await codeBuddy.stop(jobId)),
);

server.tool(
  "workbuddy_status",
  "Check whether the authorized user's WorkBuddy PC local assistant is online.",
  {},
  async () => json({ online: await client.online() }),
);

server.tool(
  "workbuddy_send_message",
  "Send a plain-text instruction to the WorkBuddy PC local assistant. This may cause WorkBuddy to use local files or tools, so keep the instruction within the user's authorized scope.",
  { content: z.string().min(1) },
  async ({ content }) => json({ messageId: await client.sendMessage(content) }),
);

server.tool(
  "workbuddy_wait_for_reply",
  "Wait briefly for messages produced after a previously sent WorkBuddy message. An empty list means the timeout elapsed and the caller may poll again.",
  {
    messageId: z.string().min(1),
    timeoutSeconds: z.number().int().min(1).max(55).default(30),
  },
  async ({ messageId, timeoutSeconds }) =>
    json({ messages: await client.waitForReply(messageId, timeoutSeconds * 1000) }),
);

server.tool(
  "workbuddy_message_history",
  "Read WorkBuddy local-assistant message history, either after a message ID or by pagination.",
  {
    messageId: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  },
  async ({ messageId, limit, offset }) =>
    json({ messages: await client.history({ messageId, limit, offset }) }),
);

server.tool(
  "workbuddy_start_development",
  "Delegate a Git implementation task to WorkBuddy. The specification must already be committed and reachable in the repository. This tool instructs WorkBuddy to push a review branch and never merge it.",
  {
    repositoryUrl: z.string().url(),
    baseBranch: gitRef.default("main"),
    workBranch: gitRef,
    specPath: repositoryPath.default(".agent-handoff/SPEC.md"),
    testCommand: z.string().optional(),
    additionalInstructions: z.string().optional(),
  },
  async (input) => {
    if (!(await client.online())) throw new Error("WorkBuddy local assistant is offline.");
    const prompt = buildDevelopmentPrompt(input);
    return json({ messageId: await client.sendMessage(prompt) });
  },
);

server.tool(
  "workbuddy_create_cloud_task",
  "Create a WorkBuddy cloud task. The public API does not expose a per-call model selector; use a preconfigured WorkBuddy model or agent profile.",
  { prompt: z.string().min(1), name: z.string().optional() },
  async ({ prompt, name }) => json(await client.createCloudTask(prompt, name)),
);

server.tool(
  "workbuddy_answer_permission",
  "Answer a WorkBuddy AskQuestion or approval request. Call only after showing the exact request to the user and receiving their decision; never auto-approve destructive or external actions.",
  {
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  },
  async ({ requestId, answers }) => {
    const content = JSON.stringify({ outcome: "selected", requestId, answers });
    return json({
      messageId: await client.sendMessage(content, "permission_response"),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
