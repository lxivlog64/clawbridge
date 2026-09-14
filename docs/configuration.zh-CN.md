# ClawBridge 完整配置

## 配置变量

### CodeBuddy HTTP API

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEBUDDY_BASE_URL` | `http://127.0.0.1:8080/api/v1` | CodeBuddy Gateway API 地址 |
| `CODEBUDDY_GATEWAY_TOKEN` | 空 | Gateway 密码；启用认证时必填 |

### SSH 启动器

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLAWBRIDGE_SSH_HOST` | `codebuddy-worker` | `~/.ssh/config` 中的主机别名，或 `user@host` |
| `CLAWBRIDGE_LOCAL_PORT` | `18080` | Codex 电脑上的回环监听端口 |
| `CLAWBRIDGE_REMOTE_PORT` | `8080` | CodeBuddy 电脑上的 Gateway 端口 |
| `CLAWBRIDGE_REMOTE_CODEBUDDY` | `codebuddy` | 远端 CodeBuddy 可执行文件路径 |
| `CLAWBRIDGE_INSTANCE` | 根据主机和端口生成 | 实例标识，用于隔离 SSH 控制连接 |

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
- `permissionMode`：推荐 `default` 或 `acceptEdits`，不要使用跳过全部权限检查的模式。
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
