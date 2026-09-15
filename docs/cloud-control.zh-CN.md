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

## 运行限制

每个项目登记项可设置 `maxRuntimeMinutes`、`maxConcurrentJobs` 与 `maxRepairRounds`，默认分别为 120 分钟、1 个并行任务和 1 轮修复。云端领取任务时会原子地检查项目并发上限；运行超时会向 CodeBuddy 请求停止，并把任务记为失败。修复轮次会写入开发指令，要求模型超过限制时报告阻塞原因而不是继续消耗积分。

无人值守 Worker 的项目应设置 `permissionProfile: "auto"`。若兼容项目仍使用 `default` 或 `acceptEdits`，Worker 会检查 CodeBuddy transcript；可执行工具调用超过 120 秒没有完成更新时，云端状态变为 `waiting_permission`，继续保留租约并允许取消或在批准后恢复。`acceptEdits` 只批准编辑，不会保证 Git 与测试命令自动执行。

这些限制以项目登记文件为准；修改 `/etc/clawbridge/projects.json` 后需要重启 VPS 服务，并同步更新相关 Worker 的项目登记文件。

## 用量记录

每次任务都会在其云端状态结果的 `usage` 字段记录请求模型、Gateway 实际返回的模型、从 CodeBuddy 接受任务起计算的耗时，以及 Gateway 明确返回的输入/输出 Token 和积分数。未由 Gateway 返回的字段固定为 `"unknown"`，不以模型名称、耗时或套餐推算积分。该记录只保存经过筛选的标量字段，不保存完整 Gateway 响应、提示词、凭据或思考过程。

## 云端审查闭环

任务交付草稿 PR 后，Codex 使用 `clawbridge_cloud_review_record` 提交 `approved` 或 `changes_requested` 结论，并必须附上审查时的 `headSha`。`clawbridge_cloud_review_status` 会查询公开 GitHub PR 的当前提交；发现 SHA 改变时，审查状态变为 `stale`，必须重新审查。私有 PR、GitHub 暂时不可达或非 GitHub 链接不会被猜测为“没有变化”，而是保持原记录且不作外部确认。

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

### 微信通知（可选）

可用 [Server酱](https://sct.ftqq.com/) 将云端任务的排队、运行、完成、失败、取消与未知状态推送到微信。将 SendKey **仅** 写入 VPS 的私密环境文件：

```bash
CLAWBRIDGE_CLOUD_SERVERCHAN_SENDKEY='你的 SendKey'
```

不要将 SendKey 提交到 Git、写入项目登记文件或发给 Codex。服务会把事件先写入本地 outbox；HTTP 失败时以 5 秒起始、最长 5 分钟的退避间隔重试。投递是“至少一次”语义，消息中的事件 ID 可用于接收端去重。若 SendKey 曾被贴到聊天、终端共享记录或 GitHub，请立即到 Server酱重新生成。

如需对接自己的系统，也可以改用通用 JSON Webhook：

```bash
CLAWBRIDGE_CLOUD_NOTIFICATION_WEBHOOK_URL='https://notify.example/events'
```

两者同时配置时，Server酱优先。

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

## 多 Worker 隔离

每个项目固定登记一个 `workerId`。领取、活动任务读取和状态回传都会校验该 Worker 的独立 Token，因此 Worker A 不能领取或更新 Worker B 的任务。多个项目可由不同 Worker 并行执行；撤销某一台 Worker 时只删除它对应的 Token 并重启 VPS 服务，其他 Worker 的 Token 和任务不受影响。实际接入第二台 Worker 前，先为它创建新的 ID、随机 Token、独立项目路径与 CodeBuddy 登录态，绝不复制第一台的 Gateway 密码或 Token。

## 备份、恢复与健康检查

使用 `scripts/backup-cloud-state.sh` 创建一致性的 SQLite 备份；不要直接复制运行中的 `cloud.sqlite` 或 WAL 文件。脚本默认每日保留 14 天，备份目录为 `/var/backups/clawbridge`，权限为仅 root 可读。安装仓库中的 systemd service/timer 并启用 timer：

```bash
sudo cp deploy/systemd/clawbridge-cloud-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawbridge-cloud-backup.timer
```

恢复演练应在维护窗口完成：停止云端服务，将当前数据库改名保留，复制选定备份到 `/var/lib/clawbridge/cloud.sqlite`，以 `clawbridge` 用户权限运行 `scripts/verify-cloud-backup.sh`，然后启动服务并访问 `/health`。不要在未验证备份前覆盖当前数据库。

日常健康检查应同时验证：`systemctl is-active clawbridge-cloud.service`、回环 `/health` 返回 `{"ok":true}`、备份 timer 最近一次执行成功，以及通知 outbox 没有持续积压。`/health` 会执行 SQLite 快速完整性检查；使用 Mac 客户端 Token 请求 `/ready` 可查看通知积压数量和 Worker 最近心跳。告警应发送到与 Server酱不同的运维渠道；连续失败、备份超过 26 小时未生成或 `/health` 不可用时，先暂停新任务并保留数据库与日志供排查。

## API 摘要

Mac 客户端 Token：

- `POST /v1/tasks`：提交 `{ projectId, spec, idempotencyKey, model? }`
- `GET /v1/tasks`：按可选 `projectId`、`state`、`limit` 列出脱敏任务
- `GET /v1/tasks/:taskId`：读取不含完整规格的状态
- `POST /v1/tasks/:taskId/cancel`：取消排队任务，或请求 Worker 停止活动任务
- `POST /v1/tasks/:taskId/reconcile`：仅在已确认远端 CodeBuddy 作业停止后，以 `{ action: "close" | "requeue", remoteJobConfirmedStopped: true }` 处置 `unknown` 任务
- `GET /v1/projects`：读取已登记的只读项目列表（仅返回项目 ID、仓库、默认分支、目标 Worker 与能力等脱敏元数据；不含本地路径、凭据、CodeBuddy Token、允许工具或任务规格）

Worker Token：

- `POST /v1/workers/:workerId/heartbeat`
- `POST /v1/workers/:workerId/claim`
- `POST /v1/tasks/:taskId/events`
- `GET /v1/workers/:workerId/tasks/:taskId`：Worker 读取自己已领取任务的紧凑状态，用于响应取消请求
- `GET /v1/workers/:workerId/active`：Worker 重启后读取自己仍持有的活动租约；含已接受 job 的任务只恢复查询，不会重新派发

除 `/health` 外均须使用 `Authorization: Bearer <token>`。不要在 URL、日志或 Git 提交中包含 Token。

## Mac 上的 Codex 接入

Mac 不需要保存 Worker 的 SSH 密钥或 CodeBuddy 密码。构建项目后，将云端 MCP 客户端登记给 Codex：

```bash
codex mcp add clawbridge-cloud \
  --env CLAWBRIDGE_CLOUD_CONTROL_URL='https://clawbridge.example.com' \
  --env CLAWBRIDGE_CLOUD_API_TOKEN='Mac 客户端 Token' \
  -- node /absolute/path/to/clawbridge/dist/src/cloud-mcp.js
```

随后使用 `clawbridge_cloud_submit` 提交任务，保存返回的 `taskId`；使用 `clawbridge_cloud_status` 查询开发、提交 SHA 与草稿 PR 状态，或以 `clawbridge_cloud_tasks` 查看任务列表。可用 `clawbridge_cloud_projects` 只读列出已登记项目，以便在提交前确认 `projectId`；该工具不会返回本地路径、凭据或任务规格。需要停止工作时使用 `clawbridge_cloud_cancel`。对于 `unknown`，先在 CodeBuddy 确认远端作业已经停止，再通过 `clawbridge_cloud_reconcile_unknown` 关闭或重新入队；错误确认会造成重复开发。Codex 可在任务提交后退出，不需要维持到 Worker 的连接。

## 上线前检查

- VPS 仅开放 `443`；控制 API 监听回环地址。
- CodeBuddy Gateway 固定为 `127.0.0.1`。
- Worker 与 Mac 使用不同 Token；每个 Worker 使用独立 Token。
- GitHub 身份只授予目标仓库的最小写权限。
- 先用测试仓库跑一个仅修改文档的任务，确认草稿 PR 和 SHA。
- 备份 VPS 状态数据库，并限制系统日志中的请求体记录。
