import type { CloudTask, CloudTaskState } from "./cloud-task-store.js";

export class CloudControlClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}

  async submit(input: { projectId: string; spec: string; idempotencyKey: string; model?: string }): Promise<{ task: CloudTask; reused: boolean }> {
    return this.request("/v1/tasks", { method: "POST", body: JSON.stringify(input) });
  }

  async task(taskId: string): Promise<CloudTask | undefined> {
    try { return (await this.request<{ task: CloudTask }>(`/v1/tasks/${encodeURIComponent(taskId)}`, {})).task; }
    catch (error) { if (error instanceof CloudApiError && error.status === 404) return undefined; throw error; }
  }

  async heartbeat(workerId: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.request(`/v1/workers/${encodeURIComponent(workerId)}/heartbeat`, { method: "POST", body: JSON.stringify({ ...(metadata ? { metadata } : {}) }) });
  }

  async claim(workerId: string): Promise<{ task: CloudTask | null; leaseMs: number }> {
    return this.request(`/v1/workers/${encodeURIComponent(workerId)}/claim`, { method: "POST", body: "{}" });
  }

  async update(taskId: string, state: Exclude<CloudTaskState, "queued" | "leased">, result?: Record<string, unknown>): Promise<CloudTask> {
    return (await this.request<{ task: CloudTask }>(`/v1/tasks/${encodeURIComponent(taskId)}/events`, {
      method: "POST", body: JSON.stringify({ state, ...(result ? { result } : {}) }),
    })).task;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new CloudApiError("Cloud control returned invalid JSON.", response.status); }
    if (!response.ok) {
      const message = typeof data === "object" && data && "error" in data && typeof data.error === "string" ? data.error : `Cloud control request failed (${response.status}).`;
      throw new CloudApiError(message, response.status);
    }
    return data as T;
  }
}

export class CloudApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "CloudApiError"; }
}
