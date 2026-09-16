---
name: luban-delegation
description: Delegate bounded software development through the configured Luban cloud MCP and review the returned GitHub PR. Use when the user says “交给鲁班”, asks to use CodeBuddy or WorkBuddy credits, or wants asynchronous Worker development; do not use for ordinary local edits.
---

# 鲁班委派

“鲁班”是用户名称；当前兼容 MCP 服务名和工具前缀仍为 `clawbridge-cloud` 与 `clawbridge_cloud_*`。

## 派发

1. 必须先调用 `clawbridge_cloud_projects`，使用返回的准确 `projectId`。目标项目未登记时停止并说明，不得改用 SSH 或直接启动 CodeBuddy。
2. 把需求整理成边界清晰的规格，包含范围、排除项、验收条件、测试要求和禁止事项。大型路线图拆成可独立审查的里程碑，避免把多个高风险阶段塞进一个长任务。
3. 调用 `clawbridge_cloud_submit`，提供唯一 `idempotencyKey`；除非用户指定其他可用模型，否则使用 `deepseek-v4.1-flash`。
4. 返回 `taskId` 后即可结束当前轮次。不要为了“盯进度”持续消耗 Codex；用户查询时再调用 `clawbridge_cloud_status` 或 `clawbridge_cloud_tasks`。

鲁班云端 Worker 已负责隔离 worktree、权限模式、运行时限、并发限制、推送分支和草稿 PR。不要绕过云端直接调用 `codebuddy_start_development`、远程 shell 或 CodeBuddy CLI。

## 异常与取消

- 使用 `clawbridge_cloud_cancel` 取消任务。
- `waiting_input` 或 `waiting_permission` 必须如实报告，不能另起重复任务规避等待。
- `unknown` 只有在确认远端 CodeBuddy 作业已经停止后，才能调用 `clawbridge_cloud_reconcile_unknown`；否则可能重复开发。

## 审查

Worker 的完成声明不是验收证据。任务成功后读取草稿 PR，对固定 `headSha` 检查实际 diff、测试、范围、迁移、安全和秘密泄漏。使用 `clawbridge_cloud_review_record` 记录结论，并用 `clawbridge_cloud_review_status` 检查新提交是否使审查过期。未经用户明确授权，不得合并、部署或发布。
