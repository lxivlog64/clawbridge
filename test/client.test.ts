import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BridgeConfig } from "../src/config.js";
import { TokenStore } from "../src/token-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";

test("client sends a local-assistant message with bearer auth", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-bridge-"));
  const config: BridgeConfig = {
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1:43119/callback",
    tokenFile: path.join(directory, "tokens.json"),
    apiBaseUrl: "https://example.test/openapi/v2",
    codeBuddyBaseUrl: "http://127.0.0.1:8080/api/v1",
    codeBuddyToken: "",
    codeBuddyRequestTimeoutMs: 1_000,
    codeBuddyMaxResponseBytes: 10_000,
    codeBuddyTranscriptMaxBytes: 16_384,
    stateDir: directory,
    projectsFile: path.join(directory, "projects.json"),
    taskDatabaseFile: path.join(directory, "tasks.sqlite"),
  };
  const store = new TokenStore(config.tokenFile);
  await store.saveToken({
    accessToken: "access",
    refreshToken: "refresh",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000,
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ code: 0, msg: "success", data: { message_id: "msg-1" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new WorkBuddyClient(config, store, fetchFn);

  assert.equal(await client.sendMessage("hello"), "msg-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://example.test/openapi/v2/localassistant/message");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer access");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    content: "hello",
    msg_type: "text",
  });
});
