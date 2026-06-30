# 治理层设计审查循环调整需求

## 背景

当前治理流程中，ClaudeCode 在审查设计稿时可能输出 `human_review_required`，系统会据此提前停止自动循环，并将 workflow 标记为 `blocked_for_human`。这会造成两个问题：

- ClaudeCode 的职责被扩大成了流程控制判断，容易误导 Codex 停止整改。
- 用户看到“流程已完成”或 `blocked_for_human` 时，会误以为审查已经结束，但审查意见中仍存在大量未解决问题。

治理层需要把职责边界重新收紧：ClaudeCode 只负责审查设计稿，Codex 只负责按审查意见整改，系统只负责按轮次循环和状态流转。

## 目标

- ClaudeCode 只输出设计审查结论和审查意见，不输出“需要人工介入”类结论。
- Codex 根据 ClaudeCode 的未通过意见继续整改。
- 系统持续执行“审查 → 整改 → 复审”循环，直到设计通过或达到最大审查轮次。
- 人工介入只在用户主动重新提交需求，或最大审查轮次结束仍未通过时发生。
- 如果存在可留到实施阶段解决的问题，系统允许进入任务计划阶段，但必须把这些问题传递到任务计划中，不能丢失。

## ClaudeCode 审查结论

ClaudeCode 的 `reviewDecision` 只允许以下三种：

```ts
"approved" | "changes_requested" | "defer_to_implementation"
```

### approved

表示设计稿已经达到可实施标准。

系统行为：

- 停止设计审查循环。
- 进入任务计划生成阶段。
- 生成可用于 `execute-plan` 的 `task-plan.json`。

### changes_requested

表示设计稿仍有必须在设计阶段整改的问题。

系统行为：

- 不进入人工介入。
- 将未解决意见交给 Codex 整改。
- Codex 更新同一个 `design.md`。
- ClaudeCode 基于更新后的 `design.md` 复审。
- 如果达到最大审查轮次仍未通过，才进入 `blocked_for_human`。

### defer_to_implementation

表示设计稿整体可实施，但仍有部分问题适合在实施阶段解决。

系统行为：

- 停止设计审查循环。
- 进入任务计划生成阶段。
- 将 deferred findings 纳入任务计划生成上下文。
- `task-plan.json` 中必须体现这些遗留问题对应的实施任务、验收标准或约束。

## 不允许的结论

ClaudeCode 不再允许输出：

```ts
"human_review_required"
```

处理要求：

- 从 schema 中移除该枚举值。
- 从 ClaudeCode prompt 中移除该结论说明。
- 从解析、修复、测试和 UI 展示中移除该结论路径。
- 如兼容历史文件，可只在读取旧 artifact 时显示原始值，但新流程不得生成该值。

## 流程规则

```text
用户提交需求
  ↓
Codex 生成或更新 design.md
  ↓
ClaudeCode 审查 design.md
  ↓
approved
  → 生成 task-plan.json

defer_to_implementation
  → 携带 deferred findings 生成 task-plan.json

changes_requested
  → Codex 整改 design.md
  → ClaudeCode 复审
  → 循环直到 approved / defer_to_implementation / 达到最大轮次

达到最大轮次仍 changes_requested
  → blocked_for_human
```

## 人工介入边界

人工介入只允许在以下情况发生：

1. 用户主动补充需求或重新提交需求。
2. 达到 `maxDesignReviewRounds` 后仍然是 `changes_requested`。

系统不得因为 ClaudeCode 单轮审查意见较多、审查意见严重、或存在不确定项，就提前进入人工介入。

## UI 状态与文案要求

页面过程日志需要区分“后台任务结束”和“设计审查通过”。

推荐文案：

- 审查通过：`设计审查已通过，正在生成任务计划。`
- 留到实施：`设计已达到可实施标准，部分问题将进入实施阶段处理。`
- 继续整改：`ClaudeCode 审查未通过，Codex 正在根据意见整改设计稿。`
- 轮次用完：`审查轮次已用完，仍存在设计阶段未解决问题，等待人工补充或提高轮次后继续。`

避免使用会误导用户的文案：

- `流程已完成`，但实际状态是 `blocked_for_human`。
- `人工复核`，但实际还能继续自动整改。

## 落盘要求

- 每轮 ClaudeCode 审查结果继续写入 `review-<round>.json`。
- 汇总审查结果继续写入 `reviews.json`。
- Codex 整改始终更新同一个 `design.md`。
- `defer_to_implementation` 的 findings 必须在后续任务计划生成输入中保留。
- 如果最终进入 `blocked_for_human`，不得生成 `task-plan.json`。

## 验收标准

- ClaudeCode 新生成的审查 JSON 不再包含 `human_review_required`。
- 当 ClaudeCode 输出 `changes_requested` 且未达到最大轮次时，系统会继续调用 Codex 整改，而不是进入 `blocked_for_human`。
- 当 ClaudeCode 输出 `defer_to_implementation` 时，系统会生成 `task-plan.json`，且任务计划包含 deferred findings 对应的实施项或约束。
- 当最大审查轮次用完且仍为 `changes_requested` 时，workflow 状态为 `blocked_for_human`，页面提示用户补充需求或提高轮次后继续。
- 页面不会把 `blocked_for_human` 显示成“审查已完成”或“流程已完成”。
- 相关 schema、prompt、解析修复逻辑、工作流循环测试和 Web API 测试均覆盖新结论集合。
