import type { BridgeConfig } from "./config.js";

interface CodeBuddyEnvelope<T> { data: T }

interface CodeBuddyErrorEnvelope { error?: { code?: string; message?: string } }

export interface CodeBuddyJobRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk";
  /** Explicit, narrowly scoped tool rules approved for this project. */
  allowedTools?: string[];
  agent?: "cli" | "ptc" | "minimal" | "create" | string;
  name?: string;
  bgIsolation?: "none" | "worktree";
}

export interface CodeBuddyJob {
  id: string;
  state?: "working" | "blocked" | "done" | "failed" | "stopped" | string;
  status?: "busy" | "waiting" | "idle" | "stopped" | string;
  tempo?: "active" | "idle" | "blocked" | string;
  alive?: boolean;
  settled?: boolean;
  sessionId?: string;
  [key: string]: unknown;
}

export interface CodeBuddyTranscript {
  sessionId?: string;
  updates: unknown[];
  truncated?: boolean;
  omittedUpdates?: number;
}

export class CodeBuddyApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CodeBuddyApiError";
  }
}

export class CodeBuddyClient {
  constructor(
    private readonly config: BridgeConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async health(): Promise<unknown> {
    const envelope = await this.request<CodeBuddyEnvelope<unknown>>("/health", {}, false);
    return envelope.data;
  }

  async dispatchJob(request: CodeBuddyJobRequest): Promise<CodeBuddyJob> {
    const envelope = await this.request<CodeBuddyEnvelope<CodeBuddyJob>>("/jobs", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return envelope.data;
  }

  async getJob(id: string): Promise<CodeBuddyJob> {
    const envelope = await this.request<CodeBuddyEnvelope<CodeBuddyJob | { job: CodeBuddyJob }>>(
      `/jobs/${encodeURIComponent(id)}`,
    );
    // The gateway returns { data: { job: ... } } for GET /jobs/:id, while
    // POST /jobs returns { data: job }. Keep accepting both documented forms.
    const data = envelope.data;
    return isJobWrapper(data) ? data.job : data;
  }

  async transcript(id: string): Promise<CodeBuddyTranscript> {
    const envelope = await this.request<CodeBuddyEnvelope<CodeBuddyTranscript>>(
      `/jobs/${encodeURIComponent(id)}/transcript`,
    );
    return limitTranscript(envelope.data, this.config.codeBuddyTranscriptMaxBytes);
  }

  async reply(id: string, text: string): Promise<unknown> {
    const envelope = await this.request<CodeBuddyEnvelope<unknown>>(
      `/jobs/${encodeURIComponent(id)}/reply`,
      { method: "POST", body: JSON.stringify({ text, bash: false }) },
    );
    return envelope.data;
  }

  async stop(id: string): Promise<unknown> {
    const envelope = await this.request<CodeBuddyEnvelope<unknown>>(
      `/jobs/${encodeURIComponent(id)}/stop`,
      { method: "POST", body: "{}" },
    );
    return envelope.data;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    requiresAuth = true,
  ): Promise<T> {
    if (requiresAuth && !this.config.codeBuddyToken) {
      throw new Error(
        "Missing CODEBUDDY_GATEWAY_TOKEN. Use the password printed by codebuddy --serve.",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.codeBuddyRequestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.codeBuddyBaseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "X-CodeBuddy-Request": "1",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(this.config.codeBuddyToken
            ? { authorization: `Bearer ${this.config.codeBuddyToken}` }
            : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CodeBuddyApiError(
          `CodeBuddy API request timed out after ${this.config.codeBuddyRequestTimeoutMs}ms.`,
        );
      }
      throw new CodeBuddyApiError(`CodeBuddy API connection failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > this.config.codeBuddyMaxResponseBytes) {
      throw new CodeBuddyApiError(
        `CodeBuddy API response exceeded ${this.config.codeBuddyMaxResponseBytes} bytes.`,
        response.status,
      );
    }
    let body: T & CodeBuddyErrorEnvelope;
    try {
      body = JSON.parse(raw) as T & CodeBuddyErrorEnvelope;
    } catch {
      throw new CodeBuddyApiError("CodeBuddy API returned invalid JSON.", response.status);
    }
    if (!response.ok || body.error) {
      const detail = body.error?.message ?? body.error?.code ?? "unspecified gateway error";
      throw new CodeBuddyApiError(
        `CodeBuddy API request failed (${response.status}): ${detail}`,
        response.status,
      );
    }
    return body;
  }
}

function isJobWrapper(value: CodeBuddyJob | { job: CodeBuddyJob }): value is { job: CodeBuddyJob } {
  return typeof value === "object" && value !== null && "job" in value;
}

function limitTranscript(transcript: CodeBuddyTranscript, maxBytes: number): CodeBuddyTranscript {
  const kept: unknown[] = [];
  let used = 0;
  let omitted = 0;
  for (let index = transcript.updates.length - 1; index >= 0; index -= 1) {
    const update = transcript.updates[index];
    if (isThoughtUpdate(update)) {
      omitted += 1;
      continue;
    }
    const serialized = JSON.stringify(update);
    const size = Buffer.byteLength(serialized ?? "null", "utf8");
    if (size > maxBytes || used + size > maxBytes) {
      omitted += 1;
      continue;
    }
    kept.unshift(update);
    used += size;
  }
  return {
    ...transcript,
    updates: kept,
    ...(omitted > 0 ? { truncated: true, omittedUpdates: omitted } : {}),
  };
}

function isThoughtUpdate(update: unknown): boolean {
  if (typeof update !== "object" || update === null) return false;
  const record = update as Record<string, unknown>;
  return [record.type, record.kind, record.event, record.role]
    .some((value) => typeof value === "string" && /thought|reasoning/i.test(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown connection error";
}
