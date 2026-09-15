# 云端控制平面端到端验收

本文描述 ClawBridge 云端控制平面的端到端验收路径：Mac 上的 Codex 提交任务，HTTPS 控制平面排队，私有 Worker 领取任务，CodeBuddy 在隔离 worktree 中开发，最后创建草稿 GitHub PR 供 Codex 审查。

本文只用于验收与人工核对，不包含任何凭据、令牌、主机地址、内网路径或运维密钥。部署细节与安全边界见[云端控制平面指南](cloud-control.zh-CN.md)。

## 验收目标

验证一条完整链路可用且边界正确：

```text
Mac Codex ──云端 MCP──> HTTPS 控制平面（排队）
                              ▲  出站 HTTPS 轮询 / 领取 / 回传
                              │
                      私有 Linux Worker ──> 回环 CodeBuddy ──> 隔离 worktree
                              │
                              └──> 推送任务分支 ──> 草稿 GitHub PR ──> Codex 审查
```

要点：控制平面只保存任务队列与状态，不保存 Worker 的 CodeBuddy 凭据或 GitHub 登录态；Worker 只做出站 HTTPS，不需要公网入站端口。

## 端到端流程

### 1. Mac Codex 提交任务

- 通过云端 MCP 工具 `clawbridge_cloud_submit` 提交 `projectId`、`spec`、`idempotencyKey`，可选 `model`。
- 提交内容仅为开发规格，不携带 Worker 的 CodeBuddy 密码或 Git 凭据。
- 返回 `taskId` 与 `reused` 标记；Codex 记录 `taskId` 后即可退出，无需维持到 Worker 的连接。

### 2. HTTPS 控制平面排队

- 客户端调用 `POST /v1/tasks`，使用 Bearer 令牌（Mac 客户端令牌）。
- 控制平面根据已登记项目解析出目标 `workerId`，创建状态为 `queued` 的任务。
- 幂等：相同 `idempotencyKey` 且输入一致时返回原任务；输入不一致时拒绝。
- 返回给客户端的状态为脱敏视图，不回传完整规格。

### 3. 私有 Worker 领取任务

- Worker 通过出站 HTTPS 定期发送心跳并调用领取接口。
- 领取是原子租约操作，租约默认 90 秒；同一 Worker 一次只领取一个任务。
- 领取前校验项目登记与预检条件（仓库可访问、路径在允许根目录内等）。
- 领取后任务进入 `leased`，运行期间 Worker 续租并回传状态。

### 4. CodeBuddy 在隔离 worktree 中开发

- 在登记仓库旁创建隔离 worktree，并切出 `clawbridge/<taskId>` 任务分支。
- 记录固定 base SHA，确保开发基线可复现。
- 通过本机回环 CodeBuddy 派发后台开发任务，可指定模型与权限模式。
- 任务状态更新为 `running`，并按需续租。

### 5. 交付与草稿 PR

- 开发完成后校验 worktree 的 HEAD SHA 与任务分支是否符合记录。
- 将任务分支推送到项目配置的交付远端，并复核远端分支 SHA 与本地一致。
- 使用 `gh` 创建**草稿** PR，base 为项目默认分支，标题包含 `taskId`，正文注明等待 Codex 审查。
- 任务状态更新为 `succeeded`，结果中附带提交 SHA 与 PR 链接。

### 6. Codex 审查

- Codex 通过 `clawbridge_cloud_status` 读取任务状态、Worker 归属、提交 SHA 与草稿 PR 状态。
- Codex 与用户审查真实 diff 与测试结果；ClawBridge 不自动合并、不自动发布。

## 状态与租约

| 状态 | 含义 |
| --- | --- |
| `queued` | 已入队，等待 Worker 领取 |
| `leased` | 已被 Worker 领取，租约有效 |
| `running` | CodeBuddy 正在隔离 worktree 中开发 |
| `succeeded` | 已推送分支并创建草稿 PR |
| `failed` | 执行失败，携带错误摘要 |
| `cancelled` | 执行被取消 |
| `unknown` | 无法判定远端状态，不会被自动重派 |

租约过期后任务可被同一 Worker 重新领取；未知状态不会自动重派，需人工介入。

## 手工验收清单

- [ ] 控制平面监听回环地址，公网仅暴露 TLS 反向代理端口，健康检查返回 `ok`。
- [ ] Mac 客户端令牌与 Worker 令牌相互独立，每个 Worker 使用各自令牌。
- [ ] 用一个测试仓库提交仅修改文档的任务，确认创建成功并返回 `taskId`。
- [ ] 任务状态由 `queued` 进入 `leased`，随后进入 `running`。
- [ ] Worker 生成隔离 worktree，并切出 `clawbridge/<taskId>` 任务分支。
- [ ] 开发完成后报告了确切的测试命令与提交 SHA。
- [ ] 任务分支已推送到交付远端，远端分支 SHA 与本地 HEAD 一致。
- [ ] 生成的草稿 PR base 为默认分支，标题包含 `taskId`。
- [ ] 任务状态更新为 `succeeded`，并附带提交 SHA 与 PR 链接。
- [ ] 使用相同 `idempotencyKey` 重提返回同一任务；输入不一致时被拒绝。
- [ ] `failed`/`unknown` 状态不会被自动重派，需人工处理。
- [ ] 在请求 URL、日志与 Git 提交中均未出现令牌或凭据。
- [ ] 撤销某 Worker 令牌并重启云端服务后，该 Worker 无法再领取任务。

## 安全边界

- 控制平面不连接 Worker 的执行端口，Worker 只做主动出站 HTTPS。
- CodeBuddy 网关仅监听回环地址，不向局域网或公网开放。
- Worker 与 Mac 使用不同的令牌；撤销 Worker 时移除其令牌并重启云端服务。
- GitHub 身份只授予目标仓库的最小写权限，交付使用草稿 PR，合并由用户决定。
- 云端状态数据库需备份，并限制日志中请求体的记录范围。
- 首次验收优先使用测试仓库，并先执行一个仅修改文档的任务。
