# ClawBridge 通用异步开发平台：开发规格

版本：草案 v1.0  
日期：2026-09-14  
适用范围：从现有 ClawBridge MCP 桥接器升级，支持多项目、多执行节点和 GitHub PR 交付。  
状态：M0 基础修复实施中；除本文件明确标为当前能力的项目外，新增工具、命令、配置与状态均为设计，不代表已实现。

## 1. 目标与约束

用户在 Codex 中描述需求，ClawBridge 将任务交给 CodeBuddy Code 后台执行。CodeBuddy 自行阅读项目、开发、测试并提交草稿 PR；用户需要验收时，Codex 获取精简交付信息和实际代码差异进行审查。

目标：

- 项目登记一次，后续通过项目 ID 派发，不反复提供机器路径。
- 支持新功能、修复、测试、文档以及已开发一半的任务交接。
- 派发后 Codex 可以立即结束当前轮次；开发期间不需要持续运行 Codex 推理。
- 在账号允许的范围内使用 CodeBuddy/WorkBuddy 共享积分，减少重复代码阅读和重复实现。
- 通过独立 worktree、任务台账、结构化交付和 GitHub 校验提高可靠性。

约束：

- 免费积分、可选模型及计费规则由服务方决定，禁止承诺永久免费或固定节省比例。
- ClawBridge 不购买积分、不自动切换到付费账号、不绕过服务方配额。
- 不自动合并、发布 Release、部署或操作生产资源。
- 通用实现不得硬编码个人目录、局域网地址、DJOneHub/AiMiShu 项目名。
- 信任目录和提示词不是操作系统隔离；强隔离使用专用用户或容器。

## 2. 当前基础与已知缺口

现有实现为 TypeScript STDIO MCP 服务，具备 CodeBuddy health、start、status、transcript、reply、stop，以及可选企业 WorkBuddy API。已有 SSH 隧道启动器和少量模拟测试。

必须先修复：

1. `getJob` 对 `data.job` 的解析与类型声明不一致。
2. `/bin/sh` 启动器依赖非标准 `$UID`，Linux 上可能启动失败。
3. SSH 启动并发、端口占用、目标校验和断线恢复不足。
4. HTTP 请求无明确超时，错误分类和响应校验不足。
5. transcript 全量输出可能使 Codex 读取巨量日志。
6. 没有任务去重、持久化、项目级权限或实际 worktree 核验。
7. GitHub 推送、PR 创建和交付验证没有形成闭环。

现有测试通过仅证明被测行为，不证明 GitHub 交付或无人值守可靠。

## 3. 第一版范围

### 必须交付

- 项目和节点登记、配置校验、诊断命令。
- SQLite 任务台账、幂等派发和重启恢复。
- 独立的非模型协调进程与远端执行准备器。
- CodeBuddy API 适配、状态归一化、阻塞识别。
- 精简结果读取和有界日志读取。
- GitHub 分支推送、草稿 PR 创建、交付验证。
- 按需审查入口、确定性通知事件和失败恢复说明。
- 当前 Mac 调度端 + Linux 执行端的真实端到端验证。

### 暂不交付

- 自动合并或部署、无限修复循环、任意账号自动切换。
- 完整图形界面、多租户 SaaS、浏览器代登录。
- 自动预测费用或保证 Token 分配比例。
- 完成后无条件唤醒 Codex。自动唤醒依赖宿主支持并需显式配置。
- Windows 原生远端执行准备器；保留节点能力模型，后续补齐。

## 4. 组件与部署

```text
Codex → MCP 前端 → 协调进程 → 远端准备器 → CodeBuddy Gateway → 开发任务
                     │             │                          │
                  SQLite       专用 worktree              Git commit
                     │                                        │
                通知事件/交付校验 ← GitHub 草稿 PR 与 CI ← 推送分支
```

### MCP 前端

只验证输入、提交任务和读取短结果。不是后台任务的生命期拥有者。STDIO 断开不得取消已接收任务。

### 协调进程

普通程序，不调用模型来判断状态。管理台账、准备、派发、轮询、交付和通知。采用本机 IPC；凭据不通过 IPC 回显。Mac 使用 launchd，Linux 使用 systemd 用户服务。

第一版协调进程运行在 Codex 所在电脑。关闭 Codex 后继续运行；电脑休眠或关机时暂停协调，CodeBuddy 已接受的任务可继续。电脑恢复后补查、交付和通知。若要求调度端关机后仍及时通知，后续将协调进程部署到常开服务器，不把这一能力写成首版承诺。

### 远端准备器

通过 SSH 运行有版本的轻量程序。接收结构化输入，使用参数数组调用 Git，禁止把需求文本拼成 shell 命令。执行目录校验、worktree 创建、状态检查、结果读取和交付前检查。不能让模型读取 GitHub 凭据来完成普通准备步骤。

### CodeBuddy Gateway

负责模型与开发工具执行。仅监听回环地址，通过 SSH 隧道访问。服务版本、接口能力、模型可用性在诊断时检查；未确认的能力不得伪装支持。

### GitHub 交付器

使用专用凭据推送任务分支并创建草稿 PR。开发 Agent 只需创建本地提交并输出交付说明；GitHub API 操作由普通程序完成，减少模型 Token。可使用 GitHub App 或指定仓库凭据；初版至少支持一种真实验证过的配置。

## 5. 配置模型

配置采用 JSON 并通过 Zod 校验。数据库、配置与日志保存在私有应用状态目录，权限限制为当前用户。项目代码仓库只保存脱敏示例。`.env.example` 不意味着程序会自动加载 `.env`，文档必须说明实际加载方式。

示例为建议格式：

```json
{
  "schemaVersion": 1,
  "workers": [{
    "id": "linux-dev",
    "sshHost": "codebuddy-worker",
    "gatewayPort": 8080,
    "codebuddyExecutable": "/opt/codebuddy/bin/codebuddy",
    "allowedRoots": ["/srv/clawbridge/projects"],
    "capabilities": ["linux", "node", "go"],
    "maxConcurrentJobs": 1,
    "credentialRef": "worker-linux-dev"
  }],
  "projects": [{
    "id": "sample-app",
    "repository": "owner/sample-app",
    "defaultBranch": "main",
    "workerId": "linux-dev",
    "remoteRepositoryPath": "/srv/clawbridge/projects/sample-app",
    "githubCredentialRef": "sample-app-delivery",
    "requiredCapabilities": ["linux", "node"],
    "testCommands": [["npm", "test"]],
    "buildCommands": [["npm", "run", "build"]],
    "defaultModel": "ACCOUNT_AVAILABLE_MODEL_ID",
    "permissionProfile": "project-development",
    "maxRuntimeMinutes": 120,
    "maxRepairRounds": 1,
    "maxConcurrentJobs": 1
  }]
}
```

- 凭据引用不是令牌值。禁止写入远端 URL、任务规格、PR、日志或数据库结果。
- 注册项目不隐式授予所有目录和仓库写权限。
- 实际权限配置应明确允许命令、工作目录及哪些动作必须暂停。
- macOS/iOS、Windows、GPU 或硬件任务通过能力匹配选择节点。Linux 测试通过不得被描述为 macOS 验收通过。
- 共享硬件、数据库和端口作为可锁定资源；不同 worktree 不代表这些资源已隔离。

## 6. 已开发一半的任务交接

1. 读取本地分支、HEAD、已暂存/未暂存变更及未跟踪文件清单，不先全量分析源码。
2. 记录当前目标、已完成内容、剩余事项、已知失败测试和明确禁改项。
3. 用户授权发布到 GitHub 的改动形成专用交接提交；未授权发布的改动使用经过范围确认的私有快照或 patch。
4. 默认排除凭据、数据库、录音、构建产物和依赖目录。未跟踪文件必须按清单纳入，不能静默遗漏。
5. 保存 `baseSha`、交接快照摘要和规格哈希，远端核验一致后开始。
6. 未提交改动不得被 reset、checkout 或同步工具覆盖。与本地继续开发并行时，以独立任务分支交付。

MVP 先支持已提交且远端可达的交接；发现本地脏工作区时返回 `handoff_required` 和文件清单，不能假装已移交。私有 patch 交接作为下一阶段功能。

## 7. 任务记录与状态

任务至少记录：

`taskId`、`idempotencyKey`、`projectId`、`workerId`、`specHash`、`baseSha`、`worktreePath`、`branch`、`remoteJobId`、`requestedModel`、`observedModel`、`createdAt`、`lastEventAt`、`lastPollAt`、`executionState`、`deliveryState`、`reviewState`、`blockReason`、`headSha`、`prUrl`、`repairCount`。

分开记录执行、交付与审查状态，避免旧的完成消息掩盖新一轮阻塞。

| 维度 | 状态 |
| --- | --- |
| 执行 | queued、preparing、dispatching、running、waiting_input、waiting_permission、stalled、succeeded、failed、cancel_requested、cancelled、unknown |
| 交付 | not_started、validating、pushing、creating_pr、ready、failed |
| 审查 | not_requested、pending、changes_requested、reviewed |

- 网络失败进入 `unknown` 或保留原状态并记录连接错误，不自动当作失败后重新派发。
- `stalled` 是可疑停滞，需要最后事件与工具状态证据，不推算百分比。
- `succeeded` 仅指执行结束；`deliveryState=ready` 才表示提交和 PR 已校验。
- 取消请求发送成功不等于全部子进程结束。核验执行状态并保留工作区，不自动删除提交。

## 8. 派发与恢复协议

1. 客户端提交项目 ID、规格、唯一幂等键和可选执行参数。
2. SQLite 事务创建任务；相同键和相同输入返回原任务，不同输入返回冲突。
3. 协调进程检查节点连接、GitHub 凭据、仓库地址、依赖、模型与权限配置。
4. 获取仓库/资源锁，fetch 并解析明确的 `baseSha`。
5. 在允许根目录下创建 `clawbridge/<taskId>` 分支与 worktree，核验真实路径、Git common dir、HEAD 和分支。
6. 向 CodeBuddy 传入已经准备好的 worktree 路径，避免再由模型创建嵌套 worktree；具体 API 参数经真实版本验证后确定。
7. 派发成功持久化远端 jobId，再更新状态；Codex 获取 taskId 后即可结束。

远端派发 API 若没有幂等能力，不能承诺严格 exactly-once。应使用远端可查询的 taskId 标记处理“已接受但回执丢失”。查询仍无法确认时保留 `dispatching/unknown`，停止自动重发并报告歧义。

同一实例并发启动 SSH 时加锁。控制连接标识必须包含主机、SSH 端口、本地端口、远端端口和实例 ID。检查控制连接存活后还须验证 Gateway 身份和健康。端口冲突不能默认连接任何已监听服务。

设置 SSH BatchMode、连接超时和保活；通过 `-n` 隔离 STDIN。shell 用户 ID 使用 `id -u`。启动器远端路径应作为参数正确转义，禁止接受任意 shell 片段。

## 9. 后台监控、阻塞与通知

- 协调程序轮询或订阅事件，不调用 Codex 推理。
- 轮询建议从 15 秒开始，对无变化任务退避至 60 秒并加抖动；连接失败单独退避。频率可配置。
- 记录最后成功连接、最后执行事件和待处理工具，区分网络断开与任务卡住。
- 权限审批与普通追问使用不同类型。API 不支持明确审批响应时，返回受支持的人工处理入口，不能把普通 reply 当作批准工具。
- 不通过改写命令绕过权限分类器失败。
- 默认不自动重启停滞任务。人工重试前先核验旧进程、worktree 和可能副作用。
- 生成持久化 outbox 事件：交付完成、失败、等待输入、等待权限、运行超时。
- 通知至少一次投递，使用事件 ID 去重，失败重试；默认本地待办箱，可选用户配置的 Webhook。
- 通知只含 taskId、项目、状态和短原因；不包含凭据、完整日志或业务隐私。

## 10. 精简结果与费用控制

默认状态响应不超过 2 KB；交付摘要不超过 8 KB；超长字段截断并标记。详细日志必须明确请求，支持游标、类型过滤与 `maxBytes`，单次默认上限 16 KB。

默认过滤模型思考事件、重复源码和完整工具输出。发生错误时返回错误类别、必要尾部日志和日志定位信息。不能为了生成摘要再让 Codex 或另一个模型通读全部 transcript。

预算控制使用可执行的边界：最大运行时间、最大并发、最大修复次数、可选最大模型轮次。积分/Token 只有服务提供真实数据时才记录，缺失为 `unknown`，不能记为零。若无法实时获得积分使用量，应标明不支持硬积分预算。

按任务记录可获得的执行用量、协调次数、回传字节数和返工次数。评估节省效果时比较同类任务的总开支，包含 Codex 审查、CodeBuddy 开发和重做成本，不只比较任务数量。

## 11. GitHub 交付与审查

交付器执行：

1. 核验任务分支不等于默认分支、提交存在且基于登记的 baseSha。
2. 检查 diff 范围、禁改文件和可能的凭据；发现问题暂停交付。
3. 记录可验证的测试命令、退出码、执行时间与对应 SHA；Agent 自述单独标记为未核验。
4. 只推送任务分支，默认禁止 force push。
5. 按 taskId 查询已存在 PR，防止重复创建；创建草稿 PR 并记录 URL。
6. 验证 GitHub 上的 head SHA 与交付 SHA 一致，记录 CI 状态。

测试或依赖安装本身会执行仓库代码，应在专用环境运行；不得把生产密钥注入测试环境。

Codex 审查时先读规格、摘要和 diff stat，再按风险读取实际 diff，记录 `reviewedSha`。PR 后续新增提交使已有审查结论过期。CI 通过不代表功能正确，硬件、平台专属验收须另行标记。

GitHub 身份可采用专用机器账号或 GitHub App；不要给执行节点不必要的管理权限。独立身份有助于区分作者与审查者。同一个 GitHub 账号仍可由 Codex 分析 diff，但不能假定自己的 PR 能由同账号提供有效独立批准。分支规则和套餐能力应实际验证。

## 12. 建议 MCP 接口

以下是新增接口设计；保留旧 `codebuddy_*` 接口一个迁移周期并标记为低层接口。

| 工具 | 输入要点 | 输出要点 |
| --- | --- | --- |
| `clawbridge_projects` | 可选项目 ID | 项目、节点、能力，不含凭据 |
| `clawbridge_preflight` | projectId | 阻断项、警告、可派发状态 |
| `clawbridge_submit` | projectId、spec、idempotencyKey、可选 model | taskId、queued 状态、去重结果 |
| `clawbridge_tasks` | 项目、状态、分页 | 精简任务列表 |
| `clawbridge_status` | taskId | 执行/交付/审查状态、最后事件、阻塞原因 |
| `clawbridge_result` | taskId | PR、SHA、测试、交付摘要、验证等级 |
| `clawbridge_logs` | taskId、cursor、types、maxBytes | 有界日志、下一游标、截断标识 |
| `clawbridge_reply` | taskId、问题 ID、答复 | 普通问题回复结果 |
| `clawbridge_cancel` | taskId | 取消请求与后续确认状态 |
| `clawbridge_review_context` | taskId | 固定 SHA 的规格、diff stat、CI 和改动列表 |

注册项目、修改凭据、允许路径和权限配置通过本地管理命令完成，不默认暴露给开发 Agent。工具应携带适当的只读/写入提示，未配置的企业传输不加载相关工具。

## 13. 实施顺序与里程碑

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| M0 基础修复 | API 响应、超时、日志限流、SSH 与 Linux 兼容 | 真实响应夹具和启动回归通过 |
| M1 项目与台账 | 配置、SQLite、任务状态、幂等键、列表 | 重启后可定位每个任务；重复请求不重复创建本地任务 |
| M2 安全派发 | 预检、准备器、worktree、资源锁、回执恢复 | 默认分支不被任务修改；失联不盲目重派 |
| M3 GitHub 交付 | 专用凭据、推送、草稿 PR、交付校验 | 真实测试仓库完成开发到 PR，SHA 一致 |
| M4 无人值守 | 协调服务、阻塞识别、通知 outbox、取消 | 关闭 Codex 后可继续并记录终态；恢复后可查询 |
| M5 审查与文档 | 精简审查上下文、部署与迁移指南、用量指标 | 可在新 Codex 任务按 taskId 获取准确交付并审查 |

先串行完成一个小任务端到端，再启用多项目并发。每阶段独立分支/PR，禁止一次性重写后宣称全部完成。

### 当前实施进度

- M0：已实现 CodeBuddy `GET /jobs/:id` 的 `data.job` 兼容解析、请求超时、响应大小限制、transcript 大小限制和思考事件过滤；SSH 启动器已改用 `id -u` 并增加启动锁、BatchMode、连接超时与保活选项。模拟回归测试已覆盖，尚未完成真实 Gateway 夹具和双端启动回归。
- M1：实施中。项目注册、静态预检、SQLite 任务台账、幂等创建和任务查询正在实现；不含远端派发。
- M2：实施中。项目受限的 CodeBuddy 派发、状态刷新、普通追问和取消正在实现。远端准备器、Git worktree 的独立核验与断线回执关联仍未完成，不能声称达到 M2 完成标准。
- M3：实施中。远端受限 Git 核验及 GitHub CLI 草稿 PR 创建正在实现。尚未完成真实测试仓库的端到端验证。
- M4：尚未开始。协调进程、持久 outbox 与恢复后通知仍未实现。
- M5：实施中。受限日志、精简交付结果和固定 SHA 的审查上下文正在实现；不包含自动审查结论。

## 14. 验收场景

必须覆盖以下真实或可控故障场景：

1. 一个 Linux Node 示例项目派发、修改、测试、推送草稿 PR，Codex 可读取真实差异。
2. 两个项目并行，无目录、分支、jobId 或 PR 串用。
3. 同项目两个任务默认排队；显式启用并发时 worktree 分离且共享资源受锁保护。
4. 有未提交修改时提示交接缺失，不丢失文件、不从旧快照继续。
5. 相同幂等键重复提交只产生一个任务；输入不同返回冲突。
6. 模拟 API 接受后连接中断，通过远端标记对账；无法确认时不重派。
7. 网络断开、Gateway 重启、协调进程重启后状态可恢复，无重复 PR。
8. 权限请求和分类器失败进入明确阻塞状态，不自动批准或改写绕过。
9. 进程存活但无事件时显示停滞证据，不报告虚构百分比。
10. 拒绝越界 cwd、符号链接逃逸和默认分支交付。
11. 取消运行任务后确认停止并记录残留，不删除代码。
12. 超长 transcript 按预算截断，思考记录默认不返回。
13. 未配置 GitHub 或推送失败不能标记交付成功。
14. 实际 PR SHA 与报告不一致时阻止审查完成。
15. Mac 与 Ubuntu 启动器验证；SSH STDIN 不吞 MCP 初始化消息。
16. 状态/API/日志/数据库导出不包含测试凭据；未配置服务不暴露工具。
17. 关闭 Codex 后任务继续；调度端休眠恢复后补查，通知不重复刷屏。

## 15. 开发 Agent 的交付要求

每个里程碑 PR 必须包含：问题说明、实现范围、已完成与未完成能力、测试命令和结果、兼容性说明、配置示例、迁移步骤以及当前 head SHA。

M0 从现有代码修复开始，不派发真实业务项目，不修改用户的旧任务或工作区。端到端测试使用专用测试仓库和测试凭据；没有这些条件时标记待验收，不用模拟测试冒充真实验证。

项目文档必须明确区分：已经实现、只提供提示词约定、需要宿主支持、尚未实现。运行结果中不得宣称模型自述已经构成代码审查或测试证明。
