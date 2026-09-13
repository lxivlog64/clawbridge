# ClawBridge

English | [简体中文](README.md)

ClawBridge is an MCP server that lets Codex delegate bounded implementation work to CodeBuddy Code on another machine, select a model and reasoning effort for each job, collect the result, and review the actual Git changes.

> ClawBridge is an independent community project and is not affiliated with or endorsed by OpenAI, Tencent, CodeBuddy, or WorkBuddy.

It supports local and SSH-tunneled workers. A separate optional transport targets the enterprise-only WorkBuddy Open API.

## Credits

Tencent's current pricing documentation says CodeBuddy and WorkBuddy share credits when the same account is used. The personal trial tier currently includes a monthly free credit allowance, so ClawBridge can consume credits already available in that account. Limits, models, multipliers, and promotions can change; see the [official pricing page](https://www.codebuddy.cn/docs/ide/Account/pricing).

## Quick start

```bash
git clone https://github.com/lxivlog64/clawbridge.git
cd clawbridge
npm install
npm run build
codebuddy --serve --port 8080
```

Export the generated Gateway password and add the MCP server:

```bash
export CODEBUDDY_BASE_URL=http://127.0.0.1:8080/api/v1
export CODEBUDDY_GATEWAY_TOKEN='your-gateway-password'

codex mcp add clawbridge \
  --env CODEBUDDY_BASE_URL="$CODEBUDDY_BASE_URL" \
  --env CODEBUDDY_GATEWAY_TOKEN="$CODEBUDDY_GATEWAY_TOKEN" \
  -- node "$(pwd)/dist/src/server.js"
```

For a worker on another machine, follow the [Chinese configuration guide](docs/configuration.zh-CN.md). The included `scripts/ssh-mcp.sh` launcher keeps the Gateway on loopback and connects through SSH.

## Safety

ClawBridge never merges code automatically. Treat worker output as an untrusted status report: verify the commit, inspect the diff, and rerun relevant tests. Never expose an unauthenticated CodeBuddy Gateway to a network.

## License

[MIT](LICENSE)
