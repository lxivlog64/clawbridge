import path from "node:path";

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
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
  };
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
