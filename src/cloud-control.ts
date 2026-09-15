import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { CloudTaskConflictError, CloudTaskStore } from "./cloud-task-store.js";
import type { ProjectRegistry } from "./project-registry.js";

const taskInput = z.object({
  projectId: z.string().min(1).max(80), spec: z.string().min(1).max(200_000),
  idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/), model: z.string().min(1).max(200).optional(),
}).strict();
const workerUpdate = z.object({
  state: z.enum(["running", "succeeded", "failed", "cancelled", "unknown"]),
  result: z.record(z.string(), z.unknown()).optional(),
}).strict();
const heartbeatInput = z.object({ metadata: z.record(z.string(), z.unknown()).optional() }).strict();
const reconcileInput = z.object({ action: z.enum(["close", "requeue"]), remoteJobConfirmedStopped: z.literal(true) }).strict();
const listInput = z.object({ projectId: z.string().min(1).max(80).optional(), state: z.enum(["queued", "leased", "running", "cancel_requested", "succeeded", "failed", "cancelled", "unknown"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export interface CloudControlOptions {
  apiToken: string;
  workerTokens: Record<string, string>;
  projects: ProjectRegistry;
  tasks: CloudTaskStore;
  leaseMs?: number;
}

/** HTTP control plane. Deploy behind TLS; this server deliberately does not expose a CodeBuddy gateway. */
export function createCloudControlServer(options: CloudControlOptions): http.Server {
  if (!options.apiToken) throw new Error("CLAWBRIDGE_CLOUD_API_TOKEN is required for cloud control.");
  const leaseMs = options.leaseMs ?? 90_000;
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });
      const client = url.pathname === "/v1/tasks" && (request.method === "POST" || request.method === "GET");
      const projectList = url.pathname === "/v1/projects" && request.method === "GET";
      const taskMatch = /^\/v1\/tasks\/([0-9a-f-]{36})$/i.exec(url.pathname);
      const eventMatch = /^\/v1\/tasks\/([0-9a-f-]{36})\/events$/i.exec(url.pathname);
      const cancelMatch = /^\/v1\/tasks\/([0-9a-f-]{36})\/cancel$/i.exec(url.pathname);
      const reconcileMatch = /^\/v1\/tasks\/([0-9a-f-]{36})\/reconcile$/i.exec(url.pathname);
      const workerMatch = /^\/v1\/workers\/([A-Za-z0-9_-]{1,80})\/(heartbeat|claim)$/.exec(url.pathname);
      const workerTaskMatch = /^\/v1\/workers\/([A-Za-z0-9_-]{1,80})\/tasks\/([0-9a-f-]{36})$/i.exec(url.pathname);
      const workerActiveMatch = /^\/v1\/workers\/([A-Za-z0-9_-]{1,80})\/active$/.exec(url.pathname);

      if (client && request.method === "POST") {
        requireToken(request, options.apiToken);
        const input = taskInput.parse(await body(request));
        const project = options.projects.require(input.projectId);
        const created = options.tasks.createOrGet({ projectId: input.projectId, workerId: project.workerId, spec: input.spec, idempotencyKey: input.idempotencyKey, requestedModel: input.model ?? project.defaultModel });
        return send(response, 201, { ...created, task: publicTask(created.task) });
      }
      if (client && request.method === "GET") {
        requireToken(request, options.apiToken);
        const input = listInput.parse(Object.fromEntries(url.searchParams));
        return send(response, 200, { tasks: options.tasks.list(input).map((task) => publicTask(task)) });
      }
      if (projectList) {
        requireToken(request, options.apiToken);
        return send(response, 200, { projects: options.projects.list() });
      }
      if (taskMatch && request.method === "GET") {
        requireToken(request, options.apiToken);
        const task = options.tasks.get(taskMatch[1]!);
        return task ? send(response, 200, { task: publicTask(task) }) : send(response, 404, { error: "Task not found." });
      }
      if (cancelMatch && request.method === "POST") {
        requireToken(request, options.apiToken);
        const task = options.tasks.requestCancellation(cancelMatch[1]!);
        return send(response, 200, { task: publicTask(task) });
      }
      if (reconcileMatch && request.method === "POST") {
        requireToken(request, options.apiToken);
        const input = reconcileInput.parse(await body(request));
        const task = options.tasks.resolveUnknown(reconcileMatch[1]!, input.action, input.remoteJobConfirmedStopped);
        return send(response, 200, { task: publicTask(task) });
      }
      if (eventMatch && request.method === "POST") {
        const task = options.tasks.get(eventMatch[1]!);
        if (!task) return send(response, 404, { error: "Task not found." });
        requireWorker(request, task.workerId, options.workerTokens);
        const update = workerUpdate.parse(await body(request));
        return send(response, 200, { task: publicTask(options.tasks.updateFromWorker(task.taskId, task.workerId, update.state, update.result, leaseMs)) });
      }
      if (workerMatch && request.method === "POST") {
        const [, workerId, action] = workerMatch;
        requireWorker(request, workerId!, options.workerTokens);
        if (action === "heartbeat") {
          const input = heartbeatInput.parse(await body(request));
          return send(response, 200, { worker: options.tasks.heartbeat(workerId!, input.metadata, leaseMs) });
        }
        if (action === "claim") {
          const task = options.tasks.claim(workerId!, leaseMs, options.projects.concurrencyLimits());
          return send(response, 200, { task: task ? publicTask(task, true) : null, leaseMs });
        }
      }
      if (workerTaskMatch && request.method === "GET") {
        const [, workerId, taskId] = workerTaskMatch;
        requireWorker(request, workerId!, options.workerTokens);
        const task = options.tasks.get(taskId!);
        if (!task || task.workerId !== workerId) return send(response, 404, { error: "Task not found." });
        return send(response, 200, { task: publicTask(task) });
      }
      if (workerActiveMatch && request.method === "GET") {
        const workerId = workerActiveMatch[1]!;
        requireWorker(request, workerId, options.workerTokens);
        return send(response, 200, { tasks: options.tasks.activeForWorker(workerId).map((task) => publicTask(task)) });
      }
      return send(response, 404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof AuthError ? 401 : error instanceof z.ZodError ? 400 : error instanceof CloudTaskConflictError ? 409 : 500;
      return send(response, status, { error: error instanceof Error ? error.message : "Unknown error." });
    }
  });
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1_048_576) throw new Error("Request body is too large.");
    chunks.push(data);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be JSON."); }
}

function publicTask(task: ReturnType<CloudTaskStore["get"]> extends infer T ? Exclude<T, undefined> : never, includeSpec = false) {
  const { spec, ...safe } = task;
  return includeSpec ? task : safe;
}

function requireToken(request: IncomingMessage, expected: string): void {
  const provided = bearer(request);
  if (!provided || !sameToken(provided, expected)) throw new AuthError("Invalid API token.");
}
function requireWorker(request: IncomingMessage, workerId: string, tokens: Record<string, string>): void {
  const expected = tokens[workerId];
  if (!expected) throw new AuthError("Unknown worker.");
  requireToken(request, expected);
}
function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}
function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
class AuthError extends Error {}
function send(response: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  response.end(text);
}
