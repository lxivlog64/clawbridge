#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { WorkBuddyOAuth } from "./oauth.js";
import { TokenStore } from "./token-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";

const config = loadConfig();
const store = new TokenStore(config.tokenFile);
const client = new WorkBuddyClient(config, store);
const oauth = new WorkBuddyOAuth(config, store);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "auth": {
      const token = await oauth.authenticateInteractively(!args.includes("--no-open"));
      console.log(JSON.stringify({ authorized: true, scope: token.scope, openId: token.openId }, null, 2));
      return;
    }
    case "status":
      console.log(JSON.stringify({ online: await client.online() }, null, 2));
      return;
    case "send": {
      const content = args.join(" ").trim();
      if (!content) throw new Error("Usage: workbuddy-bridge send <message>");
      console.log(JSON.stringify({ messageId: await client.sendMessage(content) }, null, 2));
      return;
    }
    case "history": {
      console.log(JSON.stringify({ messages: await client.history({ limit: 20 }) }, null, 2));
      return;
    }
    default:
      console.log(`workbuddy-bridge commands:
  auth [--no-open]   Authorize through a loopback OAuth callback
  status             Check whether the PC local assistant is online
  send <message>     Send a plain-text instruction
  history            Read the 20 most recent messages`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
