import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server starts and publishes the expected tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/src/server.js")],
    env: {
      PATH: process.env.PATH ?? "",
      WORKBUDDY_TOKEN_FILE: path.resolve(".workbuddy-bridge/test-unused.json"),
      CLAWBRIDGE_STATE_DIR: path.join("/tmp", `clawbridge-server-smoke-${process.pid}`),
    },
  });
  const client = new Client({ name: "workbuddy-bridge-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "clawbridge_cancel",
      "clawbridge_dispatch",
      "clawbridge_preflight",
      "clawbridge_projects",
      "clawbridge_refresh",
      "clawbridge_reply",
      "clawbridge_status",
      "clawbridge_submit",
      "clawbridge_tasks",
      "codebuddy_health",
      "codebuddy_job_status",
      "codebuddy_job_transcript",
      "codebuddy_reply_job",
      "codebuddy_start_development",
      "codebuddy_stop_job",
      "workbuddy_answer_permission",
      "workbuddy_create_cloud_task",
      "workbuddy_message_history",
      "workbuddy_send_message",
      "workbuddy_start_development",
      "workbuddy_status",
      "workbuddy_wait_for_reply",
    ]);
  } finally {
    await client.close();
  }
});
