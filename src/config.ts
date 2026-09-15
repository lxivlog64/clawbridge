import path from "node:path";
import os from "node:os";

export interface BridgeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenFile: string;
  apiBaseUrl: string;
  codeBuddyBaseUrl: string;
  codeBuddyToken: string;
  codeBuddyRequestTimeoutMs: number;
  codeBuddyMaxResponseBytes: number;
  codeBuddyTranscriptMaxBytes: number;
  stateDir: string;
  projectsFile: string;
  taskDatabaseFile: string;
  coordinatorPollMs: number;
  notificationWebhookUrl?: string;
  cloudDatabaseFile: string;
  cloudListenHost: string;
  cloudPort: number;
  cloudApiToken: string;
  cloudWorkerTokens: Record<string, string>;
  cloudControlUrl: string;
  cloudWorkerId: string;
  cloudWorkerToken: string;
  cloudWorkerPollMs: number;
  cloudNotificationWebhookUrl?: string;
  cloudServerChanSendKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const stateDir = path.resolve(env.CLAWBRIDGE_STATE_DIR ?? path.join(os.homedir(), ".clawbridge"));
  return {
    clientId: env.WORKBUDDY_CLIENT_ID ?? "",
    clientSecret: env.WORKBUDDY_CLIENT_SECRET ?? "",
    redirectUri:
      env.WORKBUDDY_REDIRECT_URI ?? "http://127.0.0.1:43119/callback",
    tokenFile: path.resolve(
      env.WORKBUDDY_TOKEN_FILE ?? ".workbuddy-bridge/tokens.json",
    ),
    apiBaseUrl: (
      env.WORKBUDDY_API_BASE_URL ?? "https://www.workbuddy.cn/openapi/v2"
    ).replace(/\/$/, ""),
    codeBuddyBaseUrl: (
      env.CODEBUDDY_BASE_URL ?? "http://127.0.0.1:8080/api/v1"
    ).replace(/\/$/, ""),
    codeBuddyToken: env.CODEBUDDY_GATEWAY_TOKEN ?? "",
    codeBuddyRequestTimeoutMs: positiveInteger(
      env.CODEBUDDY_REQUEST_TIMEOUT_MS,
      30_000,
      "CODEBUDDY_REQUEST_TIMEOUT_MS",
    ),
    codeBuddyMaxResponseBytes: positiveInteger(
      env.CODEBUDDY_MAX_RESPONSE_BYTES,
      1_048_576,
      "CODEBUDDY_MAX_RESPONSE_BYTES",
    ),
    codeBuddyTranscriptMaxBytes: positiveInteger(
      env.CODEBUDDY_TRANSCRIPT_MAX_BYTES,
      16_384,
      "CODEBUDDY_TRANSCRIPT_MAX_BYTES",
    ),
    stateDir,
    projectsFile: path.resolve(env.CLAWBRIDGE_PROJECTS_FILE ?? path.join(stateDir, "projects.json")),
    taskDatabaseFile: path.resolve(env.CLAWBRIDGE_TASK_DATABASE ?? path.join(stateDir, "tasks.sqlite")),
    coordinatorPollMs: positiveInteger(env.CLAWBRIDGE_COORDINATOR_POLL_MS, 15_000, "CLAWBRIDGE_COORDINATOR_POLL_MS"),
    cloudDatabaseFile: path.resolve(env.CLAWBRIDGE_CLOUD_DATABASE ?? path.join(stateDir, "cloud.sqlite")),
    cloudListenHost: env.CLAWBRIDGE_CLOUD_LISTEN_HOST ?? "127.0.0.1",
    cloudPort: positiveInteger(env.CLAWBRIDGE_CLOUD_PORT, 43_120, "CLAWBRIDGE_CLOUD_PORT"),
    cloudApiToken: env.CLAWBRIDGE_CLOUD_API_TOKEN ?? "",
    cloudWorkerTokens: workerTokens(env.CLAWBRIDGE_CLOUD_WORKER_TOKENS_JSON),
    cloudControlUrl: (env.CLAWBRIDGE_CLOUD_CONTROL_URL ?? "").replace(/\/$/, ""),
    cloudWorkerId: env.CLAWBRIDGE_CLOUD_WORKER_ID ?? "",
    cloudWorkerToken: env.CLAWBRIDGE_CLOUD_WORKER_TOKEN ?? "",
    cloudWorkerPollMs: positiveInteger(env.CLAWBRIDGE_CLOUD_WORKER_POLL_MS, 10_000, "CLAWBRIDGE_CLOUD_WORKER_POLL_MS"),
    ...(env.CLAWBRIDGE_CLOUD_NOTIFICATION_WEBHOOK_URL ? { cloudNotificationWebhookUrl: env.CLAWBRIDGE_CLOUD_NOTIFICATION_WEBHOOK_URL } : {}),
    ...(env.CLAWBRIDGE_CLOUD_SERVERCHAN_SENDKEY ? { cloudServerChanSendKey: env.CLAWBRIDGE_CLOUD_SERVERCHAN_SENDKEY } : {}),
    ...(env.CLAWBRIDGE_NOTIFICATION_WEBHOOK_URL ? { notificationWebhookUrl: env.CLAWBRIDGE_NOTIFICATION_WEBHOOK_URL } : {}),
  };
}

function workerTokens(value: string | undefined): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("CLAWBRIDGE_CLOUD_WORKER_TOKENS_JSON must be a JSON object."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CLAWBRIDGE_CLOUD_WORKER_TOKENS_JSON must be a JSON object.");
  const tokens: Record<string, string> = {};
  for (const [workerId, token] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(workerId) || typeof token !== "string" || token.length < 16) {
      throw new Error("CLAWBRIDGE_CLOUD_WORKER_TOKENS_JSON contains an invalid worker token.");
    }
    tokens[workerId] = token;
  }
  return tokens;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function requireOAuthConfig(config: BridgeConfig): void {
  const missing = [
    ["WORKBUDDY_CLIENT_ID", config.clientId],
    ["WORKBUDDY_CLIENT_SECRET", config.clientSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
