import type { BridgeConfig } from "./config.js";

interface CodeBuddyEnvelope<T> {
  data: T;
}

interface CodeBuddyErrorEnvelope {
  error?: { code?: string; message?: string };
}

export interface CodeBuddyJobRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk";
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
    const envelope = await this.request<CodeBuddyEnvelope<CodeBuddyJob>>(
      `/jobs/${encodeURIComponent(id)}`,
    );
    return envelope.data;
  }

  async transcript(id: string): Promise<CodeBuddyTranscript> {
    const envelope = await this.request<CodeBuddyEnvelope<CodeBuddyTranscript>>(
      `/jobs/${encodeURIComponent(id)}/transcript`,
    );
    return envelope.data;
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
    const response = await this.fetchFn(`${this.config.codeBuddyBaseUrl}${path}`, {
      ...init,
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
    const body = (await response.json()) as T & CodeBuddyErrorEnvelope;
    if (!response.ok || body.error) {
      throw new Error(
        `CodeBuddy API request failed (${response.status}): ${JSON.stringify(body)}`,
      );
    }
    return body;
  }
}
