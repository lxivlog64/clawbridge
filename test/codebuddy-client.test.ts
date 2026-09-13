import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeConfig } from "../src/config.js";
import { CodeBuddyClient } from "../src/codebuddy-client.js";

const config: BridgeConfig = {
  clientId: "",
  clientSecret: "",
  redirectUri: "http://127.0.0.1:43119/callback",
  tokenFile: "/tmp/unused-workbuddy-token.json",
  apiBaseUrl: "https://www.workbuddy.cn/openapi/v2",
  codeBuddyBaseUrl: "http://127.0.0.1:18080/api/v1",
  codeBuddyToken: "gateway-password",
};

test("CodeBuddy client dispatches a model-pinned isolated job", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ data: { id: "job-1", state: "working" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new CodeBuddyClient(config, fetchFn);
  const result = await client.dispatchJob({
    prompt: "Implement SPEC.md",
    cwd: "/repo/app",
    model: "example-code-model",
    effort: "medium",
    permissionMode: "default",
    bgIsolation: "worktree",
  });

  assert.equal(result.id, "job-1");
  assert.equal(calls[0]?.url, "http://127.0.0.1:18080/api/v1/jobs");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer gateway-password");
  assert.equal(headers["X-CodeBuddy-Request"], "1");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    prompt: "Implement SPEC.md",
    cwd: "/repo/app",
    model: "example-code-model",
    effort: "medium",
    permissionMode: "default",
    bgIsolation: "worktree",
  });
});
