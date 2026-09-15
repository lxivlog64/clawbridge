# ClawBridge 完整配置

## 配置变量

### CodeBuddy HTTP API

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEBUDDY_BASE_URL` | `http://127.0.0.1:8080/api/v1` | CodeBuddy Gateway API 地址 |
| `CODEBUDDY_GATEWAY_TOKEN` | 空 | Gateway 密码；启用认证时必填 |
| `CODEBUDDY_REQUEST_TIMEOUT_MS` | `30000` | 单次 Gateway 请求超时（毫秒） |
| `CODEBUDDY_MAX_RESPONSE_BYTES` | `1048576` | 单次 Gateway 响应上限（字节） |
| `CODEBUDDY_TRANSCRIPT_MAX_BYTES` | `16384` | MCP transcript 回传上限（字节） |

### SSH 启动器

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLAWBRIDGE_SSH_HOST` | `codebuddy-worker` | `~/.ssh/config` 中的主机别名，或 `user@host` |
| `CLAWBRIDGE_LOCAL_PORT` | `18080` | Codex 电脑上的回环监听端口 |
| `CLAWBRIDGE_REMOTE_PORT` | `8080` | CodeBuddy 电脑上的 Gateway 端口 |
| `CLAWBRIDGE_REMOTE_CODEBUDDY` | `codebuddy` | 远端 CodeBuddy 可执行文件路径 |
| `CLAWBRIDGE_SSH_PORT` | `22` | SSH 端口；SSH 别名另有端口时保持一致 |
| `CLAWBRIDGE_INSTANCE` | 根据主机和端口生成 | 实例标识，用于隔离 SSH 控制连接 |
| `CLAWBRIDGE_TUNNEL_ROOT` | `/tmp` | SSH 控制 socket 的短路径根目录；避免 macOS 长临时目录路径超限 |

### 项目台账（M1）

任务数据库默认保存在 `~/.clawbridge/tasks.sqlite`，项目登记文件默认是 `~/.clawbridge/projects.json`。可通过以下变量迁移到专用私有目录；任务台账会保存完整任务规格以便后续安全派发，不要提交到 Git 或共享目录。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLAWBRIDGE_STATE_DIR` | `~/.clawbridge` | 私有状态目录 |
| `CLAWBRIDGE_PROJECTS_FILE` | `$CLAWBRIDGE_STATE_DIR/projects.json` | 项目与执行节点配置 |
| `CLAWBRIDGE_TASK_DATABASE` | `$CLAWBRIDGE_STATE_DIR/tasks.sqlite` | SQLite 任务台账 |

示例 `projects.json`：

```json
{
  "schemaVersion": 1,
  "workers": [{
    "id": "linux-dev",
    "sshHost": "codebuddy-worker",
    "gatewayPort": 8080,
    "codebuddyExecutable": "/home/worker/.npm-global/bin/codebuddy",
    "allowedRoots": ["/home/worker/workspaces"],
    "capabilities": ["linux", "node"],
    "maxConcurrentJobs": 1,
    "credentialRef": "worker-linux-dev"
  }],
  "projects": [{
    "id": "sample-app",
    "repository": "owner/sample-app",
    "deliveryRemote": "origin",
    "defaultBranch": "main",
    "workerId": "linux-dev",
    "remoteRepositoryPath": "/home/worker/workspaces/sample-app",
    "githubCredentialRef": "sample-app-delivery",
    "requiredCapabilities": ["linux", "node"],
    "testCommands": [["npm", "test"]],
    "defaultModel": "ACCOUNT_AVAILABLE_MODEL_ID"
  }]
}
```

`credentialRef` 和 `githubCredentialRef` 只是名称，不能填令牌。M1/M2 已提供 `clawbridge_projects`、`clawbridge_preflight`、`clawbridge_submit`、`clawbridge_dispatch`、`clawbridge_refresh`、`clawbridge_reply`、`clawbridge_cancel`、`clawbridge_tasks`、`clawbridge_status`。

先用 `clawbridge_submit` 创建带唯一 `idempotencyKey` 的 `queued` 任务，再用 `clawbridge_dispatch` 显式派发。完成后使用 `clawbridge_refresh` 查询实际远端状态。网关调用超时或中断时任务会标为 `unknown`；先在 Gateway 查找同名 `clawbridge-<taskId>` 任务，不能直接重试。

当前 M2 依赖 CodeBuddy Gateway 自己创建隔离 worktree。独立远端准备器、真实 worktree 路径与 Git HEAD 核验，以及 GitHub 草稿 PR 交付仍在后续里程碑；在这些完成前，`succeeded` 只代表远端执行结束，不代表代码已交付或已审查。

### GitHub 草稿 PR（M3）

M3 已提供 `clawbridge_verify_delivery` 和 `clawbridge_create_draft_pr`。在任务刷新为 `succeeded` 后，必须先提供 CodeBuddy worktree 的实际路径进行核验；该路径必须处于项目登记的 `allowedRoots` 内，且分支不能是默认分支。核验会读取 Git HEAD 和分支名。

草稿 PR 使用执行节点上的 `gh` CLI 已有登录态。请为执行节点配置仅限目标仓库写入权限的 GitHub 身份。ClawBridge 不会强推、合并或部署；未配置 `gh`、推送失败或 SHA 不一致都会使交付状态变为 `failed`，而非伪造 PR 地址。

创建草稿 PR 时，ClawBridge 会以普通 Git 程序执行非强制 `git push --set-upstream <deliveryRemote> <taskBranch>`，再核验远端 SHA；不会要求模型自行推送，也不会 force push。已存在同一任务分支的 PR 会被复用，不重复创建。

### 真实连接回归（M0）

默认 `npm test` 不会连接远端。完成 SSH、Gateway 后，可显式运行以下命令验证本机启动器、SSH 隧道、Linux Gateway 与 MCP health：

```bash
CLAWBRIDGE_INTEGRATION=1 \
CLAWBRIDGE_SSH_HOST=codebuddy-worker \
CLAWBRIDGE_REMOTE_CODEBUDDY=/absolute/path/to/codebuddy \
npm test
```

测试不会创建开发任务、读取项目源码或输出 Gateway 密码。它只建立临时回环隧道并调用 health；使用独立本地端口和实例标识，结束时关闭 MCP 连接。

### 后台协调与审查（M4/M5）

执行 `npm run cli -- coordinator` 可在独立进程中轮询已派发的任务，并把状态变化写入 SQLite 事件 outbox；`Ctrl+C` 或 `SIGTERM` 会停止该进程。`npm run cli -- coordinator --once` 只刷新一次，适合 systemd/launchd 定时调用。轮询间隔可用 `CLAWBRIDGE_COORDINATOR_POLL_MS` 配置，默认 15 秒。

如需外部通知，可设置 `CLAWBRIDGE_NOTIFICATION_WEBHOOK_URL`。协调器会向该地址 POST 事件 ID、任务 ID、状态类型和简短摘要；成功后确认 outbox，失败则以指数退避保留重试。Webhook URL 可能包含访问凭据，应只放在私有环境变量中，不能提交到仓库。未设置该变量时绝不会发送网络通知。

在远端 CodeBuddy 模式下，可创建私有环境文件 `~/.config/clawbridge/coordinator.env`（权限建议 `600`）：

```bash
export CLAWBRIDGE_SSH_HOST=codebuddy-worker
export CLAWBRIDGE_REMOTE_CODEBUDDY=/absolute/path/to/codebuddy
export CLAWBRIDGE_LOCAL_PORT=18180
export CLAWBRIDGE_INSTANCE=coordinator
export CLAWBRIDGE_COORDINATOR_POLL_MS=15000
# 可选：export CLAWBRIDGE_NOTIFICATION_WEBHOOK_URL='https://…'
```

然后运行 `scripts/install-coordinator-service.sh`。它在 macOS 创建 launchd 用户服务，在 Linux 创建 systemd 用户服务；服务仅以当前用户运行。更新项目后重新执行安装脚本即可刷新服务定义。卸载可在 macOS 使用 `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.clawbridge.coordinator.plist`，在 Linux 使用 `systemctl --user disable --now clawbridge-coordinator.service`。

完成草稿 PR 后，用 `clawbridge_review_context` 获取固定 SHA 的变更概览；人工审查后用 `clawbridge_record_review` 记录 `reviewed` 或 `changes_requested`。在合并前调用 `clawbridge_check_review_head`；若 worktree HEAD 已变化，记录的审查会变为 `pending`，必须重新审查。

远端 Gateway 必须只监听 `127.0.0.1`。启动器不会把密码写入磁盘，但能够调用启动器的本机进程仍可能继承或观察其环境，因此 Codex 电脑和 CodeBuddy 电脑都应视为可信开发设备。

## 配置多个 ClawBridge

每个远端执行节点必须使用不同的 MCP 名称和本机端口。例如：

```bash
codex mcp add clawbridge-dev \
  --env CLAWBRIDGE_INSTANCE=dev \
  --env CLAWBRIDGE_SSH_HOST=codebuddy-dev \
  --env CLAWBRIDGE_LOCAL_PORT=18180 \
  --env CLAWBRIDGE_REMOTE_PORT=8080 \
  --env CLAWBRIDGE_REMOTE_CODEBUDDY=codebuddy \
  -- /absolute/path/to/clawbridge/scripts/ssh-mcp.sh

codex mcp add clawbridge-test \
  --env CLAWBRIDGE_INSTANCE=test \
  --env CLAWBRIDGE_SSH_HOST=codebuddy-test \
  --env CLAWBRIDGE_LOCAL_PORT=18181 \
  --env CLAWBRIDGE_REMOTE_PORT=8080 \
  --env CLAWBRIDGE_REMOTE_CODEBUDDY=codebuddy \
  -- /absolute/path/to/clawbridge/scripts/ssh-mcp.sh
```

检查登记：

```bash
codex mcp get clawbridge-dev
codex mcp get clawbridge-test
```

在 Codex 中明确指定服务名，例如：“使用 `clawbridge-dev` 的 `codebuddy_health`”，或“把测试任务交给 `clawbridge-test`”。MCP 服务名充当工具命名空间，避免同名 CodeBuddy 工具选错节点。

如果多个项目都在同一台 CodeBuddy 电脑、使用同一账号和同一个 Gateway，则不需要多个 ClawBridge。只保留一个实例，在每次任务中把 `cwd` 指向不同项目即可。

## 验证远端服务

```bash
ssh codebuddy-worker 'codebuddy daemon status'
ssh codebuddy-worker 'codebuddy --print --model glm-5.3 --max-turns 1 "只回复 OK"'
```

查看登录后可用模型：

```bash
ssh codebuddy-worker 'codebuddy --help' | grep -- '--model'
```

## 仓库准备

CodeBuddy 的 `cwd` 是 CodeBuddy 电脑上的路径，不是 Codex 电脑上的路径。先在远端克隆项目：

```bash
ssh codebuddy-worker
cd "$HOME/workspaces"
git clone git@github.com:owner/project.git
```

两台电脑都应能访问同一个 Git remote。推荐让 CodeBuddy 在独立 worktree 中工作，由 Codex 获取对应分支或 commit 后审查。

## MCP 工具参数建议

- `model`：使用登录后 `codebuddy --help` 列出的具体模型 ID，避免依赖动态别名。
- `effort`：简单修改用 `low`/`medium`，复杂设计和排错用 `high`/`xhigh`。
- `permissionMode`：后台开发默认使用 `auto`。`acceptEdits` 只自动接受文件编辑，Git、测试和目录检查等 Bash 命令仍可能等待人工批准，不适合无人值守任务。在 `default` 或 `acceptEdits` 下，ClawBridge 会检查 transcript；可执行工具调用超过 120 秒仍没有完成更新时，任务显示为 `waiting_permission` 并触发状态通知。不要使用跳过全部权限检查的模式。
- `allowedTools`：可选的会话级最小白名单，例如 `["Bash(npm test:*)", "Bash(git status:*)"]`。只为已登记项目的必要命令添加规则；不要使用泛化的 `Bash` 规则。
- `useWorktree`：Git 仓库中保持为 `true`；仅做非 Git 连通测试时才关闭。
- `cwd`：只指向专用开发目录，不指向用户主目录或系统目录。

## 企业 WorkBuddy Open API（可选）

此路线需要通过企业开发者认证并获得硬件接入权限。配置环境变量：

```bash
export WORKBUDDY_CLIENT_ID='your-client-id'
export WORKBUDDY_CLIENT_SECRET='your-client-secret'
export WORKBUDDY_REDIRECT_URI=http://127.0.0.1:43119/callback
export WORKBUDDY_TOKEN_FILE=.workbuddy-bridge/tokens.json
export WORKBUDDY_API_BASE_URL=https://www.workbuddy.cn/openapi/v2
```

完成 OAuth：

```bash
npm run cli -- auth
npm run cli -- status
```

随后按 README 的方式登记 MCP，并把以上变量通过 `codex mcp add --env` 传入。企业 WorkBuddy Open API 当前未公开逐任务模型参数；应在 WorkBuddy 中预先配置模型或 Agent 档案。

## 故障排查

### 返回 403

确认请求携带 `X-CodeBuddy-Request: 1`。ClawBridge 会自动添加该安全头。

### 返回 401

确认 `CODEBUDDY_GATEWAY_TOKEN` 与远端 `gateway.password` 一致，并重启 Gateway。

### SSH 隧道无法建立

检查 SSH 别名、密钥权限、本机端口是否已占用，以及远端服务是否监听预期端口。

### MCP 工具没有出现

运行 `codex mcp get clawbridge` 检查登记结果，然后重新加载 Codex。
