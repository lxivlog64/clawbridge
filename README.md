# ClawBridge

[English](README.en.md) | 简体中文

ClawBridge 是一个 MCP 桥接器，让 Codex 把边界清晰的开发任务交给另一台电脑上的 CodeBuddy Code，指定模型与思考强度，等待任务完成，再由 Codex 获取结果并审查 Git 变更。

> ClawBridge 是社区项目，与 OpenAI、腾讯、CodeBuddy 或 WorkBuddy 官方无隶属或背书关系。

典型架构：

```text
Codex ──MCP──> ClawBridge ──SSH 隧道──> CodeBuddy Code ──> 独立 worktree
  │                                                        │
  └────────────────── 审查 commit、diff 与测试结果 <──────┘
```

## 为什么使用 ClawBridge

- Codex 负责需求、规格和最终审查，CodeBuddy 作为独立开发 Agent。
- CodeBuddy 任务可逐次指定 `model`、`effort`、权限模式和 Git worktree。
- 支持 Codex 与 CodeBuddy 分别运行在不同电脑或虚拟机上。
- CodeBuddy 服务只监听远端回环地址，通过 SSH 隧道连接，不必向局域网或公网开放执行端口。
- 个人开发者不需要 WorkBuddy 企业硬件接入资格。

## 免费积分说明

腾讯官方定价页注明：**CodeBuddy 与 WorkBuddy 使用同一账号时积分共享，无需分别订阅**。个人体验版目前可免费使用并包含每月体验积分，因此可用 WorkBuddy/CodeBuddy 账号已有的免费积分运行 ClawBridge。

免费额度、可选模型、积分倍率和活动可能随时调整；ClawBridge 不提供或转售积分，也不保证永久免费。请始终以[官方定价页](https://www.codebuddy.cn/docs/ide/Account/pricing)和产品内显示为准。

## 工作方式

1. Codex 编写开发规格和验收条件。
2. Codex 调用 ClawBridge，在 CodeBuddy 机器上派发后台任务。
3. CodeBuddy 使用指定模型在独立 worktree 中实现和测试。
4. Codex 查询状态、读取回传记录，并验证 commit、diff 和测试。
5. 是否合并始终由用户决定；ClawBridge 不会自动合并代码。

## 环境要求

### Codex 电脑

- Codex CLI 或 Codex 桌面版
- Node.js 20+
- 能通过 SSH 访问 CodeBuddy 电脑（远程模式）

### CodeBuddy 电脑

- Linux、macOS 或 Windows（远程 SSH 示例以 Linux/macOS 为主）
- 已安装并登录 [CodeBuddy Code](https://www.codebuddy.cn/docs/cli/installation)
- 能访问待开发项目的 Git 仓库

## 快速开始：同一台电脑

```bash
git clone https://github.com/lxivlog64/clawbridge.git
cd clawbridge
npm install
npm run build
```

启动 CodeBuddy HTTP 服务：

```bash
codebuddy --serve --port 8080
```

首次启动会显示随机 Gateway 密码。在另一个终端中设置：

```bash
export CODEBUDDY_BASE_URL=http://127.0.0.1:8080/api/v1
export CODEBUDDY_GATEWAY_TOKEN='替换为 Gateway 密码'
```

登记到 Codex：

```bash
codex mcp add clawbridge \
  --env CODEBUDDY_BASE_URL="$CODEBUDDY_BASE_URL" \
  --env CODEBUDDY_GATEWAY_TOKEN="$CODEBUDDY_GATEWAY_TOKEN" \
  -- node "$(pwd)/dist/src/server.js"
```

## 快速开始：局域网 Linux 虚拟机

在虚拟机安装、登录 CodeBuddy Code，并准备专用工作目录：

```bash
mkdir -p "$HOME/workspaces"
cd "$HOME/workspaces"
codebuddy
```

首次进入时只信任专用的 `workspaces` 目录，不要直接信任整个主目录。完成 `/login` 后，启用带密码的用户级后台服务：

```bash
codebuddy config set -g gateway.auth password
codebuddy config set -g gateway.password "$(openssl rand -hex 32)"
codebuddy daemon install --port 8080 --permission-mode acceptEdits
codebuddy daemon status
```

在 Codex 电脑配置 SSH 别名，例如 `~/.ssh/config`：

```sshconfig
Host codebuddy-worker
    HostName 192.168.1.50
    User your-user
    IdentityFile ~/.ssh/your-key
```

构建 ClawBridge 后，登记远程启动器：

```bash
export CLAWBRIDGE_SSH_HOST=codebuddy-worker
export CLAWBRIDGE_REMOTE_CODEBUDDY=codebuddy

codex mcp add clawbridge --env CLAWBRIDGE_SSH_HOST="$CLAWBRIDGE_SSH_HOST" \
  --env CLAWBRIDGE_REMOTE_CODEBUDDY="$CLAWBRIDGE_REMOTE_CODEBUDDY" \
  -- "$(pwd)/scripts/ssh-mcp.sh"
```

启动器会：

- 将本机 `127.0.0.1:18080` 转发到远端 `127.0.0.1:8080`；
- 通过 SSH 临时读取 Gateway 密码；
- 把密码仅放入 ClawBridge 进程环境，不写入项目文件。

所有远程选项见[完整配置指南](docs/configuration.zh-CN.md)。

### 多个执行节点

多个 CodeBuddy 电脑需要分别登记不同的 MCP 名称，并为每个实例设置唯一的 `CLAWBRIDGE_LOCAL_PORT` 和 `CLAWBRIDGE_INSTANCE`。例如 `clawbridge-dev`、`clawbridge-test`。完整命令见[多实例配置](docs/configuration.zh-CN.md#配置多个-clawbridge)。

同一台 CodeBuddy 电脑上的多个项目不需要多个 ClawBridge；派发时使用不同的远端 `cwd` 即可。

## 在 Codex 中使用

重新加载 Codex 后，可以这样描述任务：

> 使用 ClawBridge，让远端 CodeBuddy 在 `/home/user/workspaces/my-app` 中使用 `glm-5.3`、`high` 思考强度和独立 worktree 实现登录限流；完成后读取结果，并审查实际 Git diff 和测试。

可用 MCP 工具：

- `codebuddy_health`
- `codebuddy_start_development`
- `codebuddy_job_status`
- `codebuddy_job_transcript`
- `codebuddy_reply_job`
- `codebuddy_stop_job`

模型列表以登录后执行 `codebuddy --help` 的输出为准。模型供应、账号地区和套餐可能影响实际可用范围。

## 企业 WorkBuddy 接入（可选）

项目也保留 WorkBuddy Open API 传输，但硬件接入要求企业开发者资格。个人开发者建议使用上面的 CodeBuddy Code HTTP API 路线。企业配置见[完整配置指南](docs/configuration.zh-CN.md#企业-workbuddy-open-api可选)。

## 安全原则

- 不要把 CodeBuddy Gateway 直接绑定到 `0.0.0.0` 或暴露到公网。
- 不要提交 Gateway 密码、OAuth Client Secret、访问令牌或 SSH 私钥。
- 不要让 Agent 默认信任整个用户主目录。
- 回传消息不是完成证明；必须检查真实 commit、diff 和测试结果。
- 不自动批准删除、部署、发布、合并或访问凭据等高影响操作。

更多内容见 [SECURITY.md](SECURITY.md)。CodeBuddy HTTP API 当前标记为 Beta，升级 CodeBuddy 后建议运行 `npm test` 并做一次连接测试。

## 开发

```bash
npm run check
npm test
```

## 许可证

[MIT](LICENSE)
