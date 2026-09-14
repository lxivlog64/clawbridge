import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const enabled = process.env.CLAWBRIDGE_INTEGRATION === "1";

test("SSH launcher reaches a real remote CodeBuddy Gateway through MCP", { skip: !enabled }, async () => {
  const required = ["CLAWBRIDGE_SSH_HOST", "CLAWBRIDGE_REMOTE_CODEBUDDY"];
  for (const name of required) assert.ok(process.env[name], `${name} is required for this integration test.`);

  const transport = new StdioClientTransport({
    command: path.resolve("scripts/ssh-mcp.sh"),
    env: {
      PATH: process.env.PATH ?? "",
      CLAWBRIDGE_SSH_HOST: process.env.CLAWBRIDGE_SSH_HOST!,
      CLAWBRIDGE_REMOTE_CODEBUDDY: process.env.CLAWBRIDGE_REMOTE_CODEBUDDY!,
      CLAWBRIDGE_SSH_PORT: process.env.CLAWBRIDGE_SSH_PORT ?? "22",
      CLAWBRIDGE_REMOTE_PORT: process.env.CLAWBRIDGE_REMOTE_PORT ?? "8080",
      CLAWBRIDGE_LOCAL_PORT: process.env.CLAWBRIDGE_LOCAL_PORT ?? String(20_000 + (process.pid % 20_000)),
      CLAWBRIDGE_INSTANCE: `m0-integration-${process.pid}`,
      CLAWBRIDGE_STATE_DIR: path.join("/tmp", `clawbridge-m0-${process.pid}`),
      WORKBUDDY_TOKEN_FILE: path.join("/tmp", `clawbridge-m0-token-${process.pid}.json`),
    },
  });
  const client = new Client({ name: "clawbridge-m0-integration", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "codebuddy_health"));
    const health = await client.callTool({ name: "codebuddy_health", arguments: {} });
    assert.notEqual(health.isError, true, JSON.stringify(health.content));
  } finally {
    await client.close();
  }
});
