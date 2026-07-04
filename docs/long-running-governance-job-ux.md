# 长时间治理任务的人机交互优化建议

## 背景

当前治理流程会分阶段调用 Codex 和 ClaudeCode，例如：

1. Codex 生成或整改设计稿。
2. ClaudeCode 审查设计稿。
3. Codex 生成或整改 task-plan。
4. ClaudeCode 审查 task-plan。
5. 本地门禁校验 approved 结论。
6. 必要时再交给 ClaudeCode 仲裁本地门禁。

这些调用不是一次性完成，而是按轮次、按阶段串行推进。界面如果只显示“Codex 正在根据第 N 轮任务计划审查意见整改”，用户很难判断任务是在正常等待、已经完成但页面未刷新、还是卡住了。

## 目标

1. 让用户清楚看到当前正在执行哪个阶段。
2. 让用户知道当前外部命令是否仍在运行。
3. 让用户看到最近一次产物更新时间。
4. 在长时间无进展时给出可操作选择。
5. 避免用户重复启动新流程导致旧进程回写覆盖新产物。

## 推荐展示模型

将后台任务拆成“阶段时间线”展示，而不是只展示一行 currentStep。

每个阶段建议包含以下字段：

| 字段 | 说明 |
|---|---|
| stageId | 稳定阶段标识，例如 `task_plan_revision`。 |
| round | 当前轮次，例如 `42`。 |
| actor | 当前执行者，例如 `codex`、`claude-code`、`local-gate`。 |
| status | `pending`、`running`、`completed`、`failed`、`stalled`、`stopped`。 |
| startedAt | 阶段开始时间。 |
| completedAt | 阶段完成时间。 |
| elapsedSeconds | 阶段已耗时。 |
| processId | 外部命令 PID。 |
| commandSummary | 外部命令摘要，不展示完整 prompt。 |
| artifactPath | 阶段产物路径。 |
| artifactLastWriteTime | 阶段相关产物最后更新时间。 |
| decision | 审查类阶段的结论，例如 `approved`、`changes_requested`。 |
| findingCount | 审查类阶段的 finding 数量。 |

## 页面交互建议

### 顶部状态

顶部仍保留一句总状态，但应加入更多可判断信息：

```text
任务计划整改中：第 42 轮，Codex 已运行 23 分钟，最近产物更新于 16:59:29。
```

当检测到停滞时：

```text
可能卡住：Codex 仍在运行，但 20 分钟内没有产物更新，CPU 活动很低。
```

### 阶段时间线

示例：

```text
✓ 第 41 轮 task-plan 审查完成：changes_requested，11 个问题
✓ 第 42 轮 task-plan 草稿归一化完成：passed，0 个变更
✓ 第 42 轮 task-plan 审查完成：changes_requested，10 个问题
… 第 42 轮 Codex 整改中：已运行 23 分钟，PID 27712
```

### 外部命令运行状态

建议展示：

```text
外部命令
- actor：codex
- pid：27712
- startedAt：2026-07-04 16:59:30
- elapsed：1379s
- cpuDeltaLast5s：0.05s
- outputFile：last-message.md
```

如果命令已经结束：

```text
Codex 命令已结束，正在解析输出并写入 task-plan-draft.json。
```

如果命令结束但没有输出：

```text
Codex 命令已结束，但没有写入最终消息，流程需要人工处理。
```

## 停滞检测

建议实现一个轻量 heartbeat。

检测信号：

1. 外部命令进程是否仍存在。
2. 最近 N 秒 CPU 时间是否有增长。
3. 相关产物文件 `LastWriteTime` 是否变化。
4. job 日志是否有新增。
5. stdout/stderr 或 final message 文件是否变化。

推荐默认阈值：

| 场景 | 建议阈值 |
|---|---|
| Codex 设计整改 | 15 分钟无产物更新提示可能卡住。 |
| Codex task-plan 整改 | 15 分钟无产物更新提示可能卡住。 |
| ClaudeCode 审查 | 10 分钟无产物更新提示可能卡住。 |
| 本地门禁 | 2 分钟未结束视为异常。 |

停滞状态不等同于失败。建议标记为 `stalled`，并让用户选择下一步。

## 用户操作

停滞时提供三个按钮：

1. 继续等待。
2. 停止本次任务。
3. 停止并重试当前阶段。

重试当前阶段时必须复用当前已落盘产物，例如：

1. 当前 `task-plan-draft.json`。
2. 当前轮次的 `task-plan-review-latest.json` 或对应 review。
3. 已批准设计稿 `design.md`。
4. 既有 `task-plan-reviews.json` 历史。

## 防覆盖保护

启动新的治理任务或继续审查前，应检查是否存在同一 workflow 的运行中 job 或外部命令。

如果存在，应阻止直接启动，并提示：

```text
检测到同一 workflow 仍有 Codex 进程运行。若继续启动新任务，旧进程稍后返回时可能覆盖当前产物。请先停止旧任务或确认强制继续。
```

强制继续也应生成新的 job 目录，避免复用旧临时输出路径。

## 建议持久化的 job 目录

当前 Codex CLI 使用临时目录保存 `last-message.md`，结束后会清理。建议将 job 运行信息持久化到 workflow artifact 目录：

```text
.ao-control-plane/<workflowId>/jobs/<jobId>/
  status.json
  events.jsonl
  stdout.log
  stderr.log
  prompt-summary.md
  command.json
  final-message.md
```

`status.json` 示例：

```json
{
  "jobId": "JOB-20260704T165930Z",
  "workflowId": "WF-20260630T031508Z",
  "stageId": "task_plan_revision",
  "round": 42,
  "actor": "codex",
  "status": "running",
  "processId": 27712,
  "startedAt": "2026-07-04T16:59:30+08:00",
  "lastHeartbeatAt": "2026-07-04T17:22:29+08:00",
  "artifactLastWriteTime": "2026-07-04T16:59:29+08:00"
}
```

## 交付分层与完成口径

以下分层不是可选优先级，而是同一项体验整改的递进交付顺序。每一层都属于本需求范围；上一层完成后，应继续实现下一层，直到“完整交付口径”全部满足。

### 第一层：状态可见

目标是让用户能判断流程当前停在哪个阶段。

1. 在 job snapshot 中记录当前阶段、轮次、actor、startedAt。
2. 在启动 Codex / ClaudeCode 时记录 PID。
3. 页面显示 elapsedSeconds、PID、最近产物更新时间。
4. 阶段时间线展示 Codex、ClaudeCode、local-gate、local-gate arbitration 的开始和完成状态。
5. 审查类阶段展示 decision 和 findingCount。

### 第二层：停滞可判断

目标是让系统主动识别“进程仍在，但可能没有推进”的状态。

1. 采样外部命令是否仍存在。
2. 采样最近一段时间 CPU delta。
3. 采样相关产物文件 LastWriteTime。
4. 对 Codex 和 ClaudeCode 分别配置默认停滞阈值。
5. 超过阈值且无产物更新时，将阶段标记为 `stalled`，并显示“可能卡住”。

### 第三层：操作可恢复

目标是用户遇到停滞时可以安全处理，而不是只能刷新页面或重复启动。

1. 停止 job 时同时 abort 外部命令。
2. 增加“停止本次任务”。
3. 增加“停止并重试当前阶段”。
4. 重试当前阶段时复用当前已落盘产物和既有 review 历史。
5. 同一 workflow 新任务启动前检查旧 job，存在运行中写入任务时必须提示覆盖风险。

### 第四层：过程可复盘

目标是让长时间任务结束、失败或被停止后仍可追踪原因。

1. 持久化 `jobs/<jobId>/status.json` 和 `events.jsonl`。
2. 保留 final message、stdout 和 stderr。
3. 保存 command 摘要和 prompt-summary。
4. 支持用户在页面展开查看最近一次 review finding 摘要。
5. job 结束后保留阶段时间线，不因页面刷新丢失。

### 完整交付口径

本优化完成时，以上四层均应落地。若需要拆分开发批次，可以按层提交，但不能将后续层定义为可选增强。

## 验收标准建议

1. 用户可以在页面看到当前执行阶段是 Codex、ClaudeCode 还是 local-gate。
2. 用户可以看到当前轮次和当前阶段已耗时。
3. 当外部命令超过阈值且产物未更新时，页面显示 `stalled` 提示。
4. 用户可以停止卡住的任务。
5. 停止后不会继续写入 workflow 产物。
6. 重试当前阶段不会丢失既有 review 历史。
7. 同一 workflow 存在运行中 job 时，页面阻止直接启动第二个会写同一产物的 job。
