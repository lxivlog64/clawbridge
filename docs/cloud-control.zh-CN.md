# 云端控制平面（Ubuntu VPS）

本功能把任务队列和状态协调放到 VPS；CodeBuddy、Git 仓库工作区与 GitHub 登录态仍留在私有 Linux Worker。VPS 不连接 Worker 的 `8080` 端口，Worker 主动通过 HTTPS 领取任务。

```text
Codex on Mac → HTTPS control API on VPS ← outbound HTTPS polling ← Linux Worker
                                                              └→ localhost CodeBuddy
```

## 当前可用范围

- VPS：带 Bearer Token 的任务提交、查询、Worker 心跳、原子租约领取与状态回传。
- Worker：领取任务，在本地创建受控 worktree，调用本机回环 CodeBuddy，完成后推送任务分支并创建草稿 PR。
- Codex 的云端 MCP 客户端已提供提交、状态查询与只读项目发现；PostgreSQL、多副本调度、浏览器控制台与自动扩缩容尚未实现。

任务租约默认 90 秒。Worker 在运行期间回传状态并续租；Worker 离线时，租约会过期，后续版本会提供更严格的恢复与人工接管流程。未知状态不会自动重派。

## VPS 安装

在 Ubuntu VPS 上创建专用非 root 用户，克隆仓库并安装 Node.js 20+。不要把 Worker 的 CodeBuddy 密码、GitHub 凭据或 SSH 私钥复制到 VPS。

创建仅该用户可读的环境文件，例如 `/etc/clawbridge/cloud.env`：

```bash
CLAWBRIDGE_STATE_DIR=/var/lib/clawbridge
CLAWBRIDGE_PROJECTS_FILE=/etc/clawbridge/projects.json
CLAWBRIDGE_CLOUD_LISTEN_HOST=127.0.0.1
CLAWBRIDGE_CLOUD_PORT=43120
CLAWBRIDGE_CLOUD_API_TOKEN='生成的 Mac 客户端 Token'
CLAWBRIDGE_CLOUD_WORKER_TOKENS_JSON='{"linux-dev":"生成的 Worker Token"}'
```

项目登记文件只保存项目 ID、目标 Worker ID 与非敏感仓库元数据；它不保存访问令牌。其 `workerId` 必须与 Worker 的 ID 一致。

运行：

```bash
set -a
. /etc/clawbridge/cloud.env
set +a
npm ci
npm run build
npm run cli -- cloud-server
```

生产环境请用 systemd 运行该命令，并在 Caddy 或 Nginx 后面提供 TLS。应用默认仅监听 `127.0.0.1`，反向代理是唯一应面向公网的组件。必须配置有效域名、HTTPS、请求大小限制与访问日志脱敏。

## Worker 安装

在已登录 CodeBuddy 的 Linux Worker 创建私有环境文件：

```bash
CLAWBRIDGE_STATE_DIR=/home/worker/.clawbridge
CLAWBRIDGE_PROJECTS_FILE=/home/worker/.clawbridge/projects.json
CLAWBRIDGE_CLOUD_CONTROL_URL='https://clawbridge.example.com'
CLAWBRIDGE_CLOUD_WORKER_ID='linux-dev'
CLAWBRIDGE_CLOUD_WORKER_TOKEN='与 VPS 中 linux-dev 对应的 Token'
CODEBUDDY_BASE_URL='http://127.0.0.1:8080/api/v1'
CODEBUDDY_GATEWAY_TOKEN='仅保留在 Worker 的 Gateway 密码'
```

启动 Worker：

```bash
set -a
. ~/.config/clawbridge/worker.env
set +a
npm run cli -- cloud-worker
```

Worker 只需能出站访问 VPS 的 HTTPS 地址；无需公网 IP、入站端口或 VPS SSH 登录。每台 Worker 使用不同的 ID 和 Token。撤销某个 Worker 时，从 VPS 的 `CLAWBRIDGE_CLOUD_WORKER_TOKENS_JSON` 删除该项并重启云端服务。

## API 摘要

Mac 客户端 Token：

- `POST /v1/tasks`：提交 `{ projectId, spec, idempotencyKey, model? }`
- `GET /v1/tasks/:taskId`：读取不含完整规格的状态
- `GET /v1/projects`：读取已登记的只读项目列表（仅返回项目 ID、仓库、默认分支、目标 Worker 与能力等脱敏元数据；不含本地路径、凭据、CodeBuddy Token、允许工具或任务规格）

Worker Token：

- `POST /v1/workers/:workerId/heartbeat`
- `POST /v1/workers/:workerId/claim`
- `POST /v1/tasks/:taskId/events`

除 `/health` 外均须使用 `Authorization: Bearer <token>`。不要在 URL、日志或 Git 提交中包含 Token。

## Mac 上的 Codex 接入

Mac 不需要保存 Worker 的 SSH 密钥或 CodeBuddy 密码。构建项目后，将云端 MCP 客户端登记给 Codex：

```bash
codex mcp add clawbridge-cloud \
  --env CLAWBRIDGE_CLOUD_CONTROL_URL='https://clawbridge.example.com' \
  --env CLAWBRIDGE_CLOUD_API_TOKEN='Mac 客户端 Token' \
  -- node /absolute/path/to/clawbridge/dist/src/cloud-mcp.js
```

随后使用 `clawbridge_cloud_submit` 提交任务，保存返回的 `taskId`；使用 `clawbridge_cloud_status` 查询开发、提交 SHA 与草稿 PR 状态。可用 `clawbridge_cloud_projects` 只读列出已登记项目，以便在提交前确认 `projectId`；该工具不会返回本地路径、凭据或任务规格。Codex 可在任务提交后退出，不需要维持到 Worker 的连接。

## 上线前检查

- VPS 仅开放 `443`；控制 API 监听回环地址。
- CodeBuddy Gateway 固定为 `127.0.0.1`。
- Worker 与 Mac 使用不同 Token；每个 Worker 使用独立 Token。
- GitHub 身份只授予目标仓库的最小写权限。
- 先用测试仓库跑一个仅修改文档的任务，确认草稿 PR 和 SHA。
- 备份 VPS 状态数据库，并限制系统日志中的请求体记录。
