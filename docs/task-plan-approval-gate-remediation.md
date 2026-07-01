# 任务计划审查放行链路整改方案

## 1. 背景

以 `C:\workspace\fast-transport\.ao-control-plane\WF-20260630T031508Z` 为样本检查后发现，当前任务计划生成与任务计划审查流程存在“仍有问题但被放行”的风险。主要表现为：设计审查存在 `defer_to_implementation` 遗留项，任务计划第一轮审查存在 blocking、major、minor 未解决项，但第二轮任务计划审查返回 `approved` 后，系统直接进入 `executing`，未再执行本地强制门禁校验。

本整改方案用于指导后续代码整改，目标是让任务计划放行由“模型结论驱动”升级为“模型审查 + 本地确定性门禁 + 跨轮问题闭环”共同决定。

## 2. 样本问题证据

### 2.1 设计审查遗留项未被强制闭环

样本 `reviews.json` 第 3 轮结论为 `defer_to_implementation`，其中仍包含实施期遗留问题：

- `DRF-IMPL-001`：`severity=blocking`，`status=accepted_as_is`。
- `DRF-IMPL-002`：`severity=major`，`status=unresolved`。
- `DRF-IMPL-003`：`severity=major`，`status=unresolved`。
- `DRF-IMPL-004` 至 `DRF-IMPL-006`：仍为 unresolved 的实施期问题。

这类问题可以进入实施期，但必须被任务计划显式承接，不能只依赖审查模型口头判断。

### 2.2 任务计划第一轮 blocking 问题后续没有确定性验证

样本 `task-plan-reviews.json` 第 1 轮发现了多个 unresolved 问题，包括：

- `TPF-001`：`executionPolicy` 全部为默认策略，blocking。
- `TPF-002`：跨平台并行实现任务缺少前置共享契约冻结，blocking。
- `TPF-003` 至 `TPF-005`：验收标准、跨语言字段贯通、结构化产物契约存在 major 风险。
- `TPF-006` 至 `TPF-008`：性能复现、RawIp 权限失败、G0 仓库访问指引存在 minor 风险。

第 2 轮任务计划审查返回 `approved` 后，系统没有对第 1 轮 unresolved finding 做逐项覆盖验证。

### 2.3 `executionPolicy` 规则存在生成与审查冲突

当前生成逻辑要求任务的 `executionPolicy` 等于默认策略；审查提示又要求默认策略应打回。这会造成两类问题：

- Codex 按生成规则输出全默认策略。
- ClaudeCode 第一轮可能打回，但第二轮可能被话术带偏后批准。

该规则冲突必须先统一，否则后续审查结果不稳定。

### 2.4 放行逻辑过度信任模型结论

当前 `runTaskPlanReviewLoop` 中，只要任务计划审查返回 `reviewDecision=approved`，即直接返回 `approved=true`。缺少以下本地硬校验：

- 是否仍存在上一轮 blocking 或 major unresolved finding。
- 设计审查 `defer_to_implementation` finding 是否被任务计划承接。
- `executionPolicy` 是否符合项目统一规则。
- 依赖图、人工门禁、任务粒度、验收标准可验证性是否满足底线要求。

## 3. 整改目标

1. 任务计划不得仅凭 ClaudeCode 返回 `approved` 就放行。
2. 所有 blocking 和 major finding 必须显式闭环，或转换为人工门禁。
3. `defer_to_implementation` 的设计遗留项必须在任务计划中有可追踪承接点。
4. `executionPolicy` 规则必须在 schema、Codex 生成提示、ClaudeCode 审查提示、本地校验中保持一致。
5. 任务计划通过后，系统应能输出“为什么可以通过”的结构化依据。
6. 任务计划不满足硬门禁时，应强制转为 `changes_requested` 或 `blocked_for_human`，不能进入 `executing`。

## 4. 必须整改项

### 4.1 新增任务计划本地硬校验器

新增模块建议：`src/workflow/task-plan-gates.ts`。

校验器输入：

- `workflowId`
- `approvedDesign`
- `deferredFindings`
- `plan`
- `reviews`
- 当前轮 `review`

校验器输出：

```ts
interface TaskPlanGateResult {
  passed: boolean;
  findings: Array<{
    id: string;
    title: string;
    body: string;
    severity: "blocking" | "major" | "minor" | "observation";
    status: "unresolved" | "addressed" | "accepted_as_is";
    source: "local-gate";
  }>;
}
```

必须覆盖以下硬校验：

- `taskId` 唯一，且依赖只引用已存在任务。
- 依赖图无环、无自依赖。
- 需要人工确认的任务必须使用 `dependencyCondition=manual_gate`。
- 任务验收标准不得超过 7 条。
- 每个任务必须有 `aoPrompt`，且包含 `workflowId`、`taskId`、任务名称、AO 角色、验收标准、上下文摘要。
- 禁止出现 `agent`、`model`、`provider`、`codex`、`claudeCode` 等执行模型选择字段。
- `aoPrompt` 禁止要求 AO worker 自行选择或切换 agent、model。
- 跨平台并行实现任务之前必须存在共享接口、协议、契约或测试骨架冻结任务。
- `defer_to_implementation` finding 必须能在任务标题、描述、验收标准或 `aoPrompt` 中找到承接证据。

### 4.2 修复 `executionPolicy` 规则冲突

必须先二选一统一规则。

推荐方案：支持差异化 `executionPolicy`。

原因：用户期望流程是“开发人员开发并自测试，测试人员测试，三轮不通过交由审查人员评判，再由审查人员审查并返回对应开发优化，直至通过或三轮审查后任务完成并提交 RP”。不同任务类型对 QA、回归、审查轮次的要求天然不同，例如 docs、review、verification、implementation 不应完全一样。

整改点：

- 修改 `src/schemas/execution-policy.ts`，不再要求所有字段必须等于 `defaultExecutionPolicy`。
- 保留字段完整性要求。
- 限制合理范围：
  - `developerSelfTestRequired`：boolean。
  - `qaRequired`：boolean。
  - `regressionRequired`：boolean。
  - `reviewerRequired`：boolean。
  - `maxQaRounds`：1 至 3。
  - `maxReviewRounds`：1 至 3。
  - `requirePrOrRp`：boolean。
- 修改 Codex 任务生成提示，要求按任务类型显式声明策略，不允许全表无脑默认。
- 修改 ClaudeCode 审查提示，审查“是否差异化且合理”，而不是与 schema 冲突。
- 修改测试中依赖 `defaultExecutionPolicy` 的用例。

建议策略基线：

| 任务类型 | developerSelfTestRequired | qaRequired | regressionRequired | reviewerRequired | maxQaRounds | maxReviewRounds | requirePrOrRp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| implementation | true | true | true | true | 3 | 3 | true |
| test | true | true | true | true | 3 | 2 | true |
| verification | false | true | true | true | 3 | 2 | true |
| design | true | false | false | true | 1 | 3 | true |
| review | false | false | false | true | 1 | 3 | true |
| docs | true | true | false | true | 2 | 2 | true |

### 4.3 在任务计划审查循环中接入硬门禁

修改 `src/workflow/task-plan-review-loop.ts`。

当前逻辑：

```ts
if (review.reviewDecision === "approved") {
  return { approved: true, ... };
}
```

整改后逻辑：

```ts
const gate = validateTaskPlanApprovalGate({
  workflowId,
  approvedDesign,
  deferredFindings,
  plan,
  reviews,
  currentReview: review
});

if (review.reviewDecision === "approved" && gate.passed) {
  return { approved: true, ... };
}

if (review.reviewDecision === "approved" && !gate.passed) {
  const syntheticReview = convertGateFailuresToTaskPlanReview(gate);
  reviews.push(syntheticReview);
  // 若还有轮次，则交给 Codex 继续整改；若已到最大轮次，则 blocked_for_human。
}
```

要求：

- 本地门禁失败时，不允许进入 `executing`。
- 本地门禁发现的问题要写入 `task-plan-reviews.json`，方便用户看见真实阻断原因。
- 本地门禁问题的 reviewer 可标记为 `local-gate` 或在 finding body 中明确来源。

### 4.4 增加跨轮 finding 闭环校验

新增能力：上一轮 unresolved finding 必须在下一版任务计划中被证明已处理。

最低实现方式：

- 对上一轮 `severity=blocking|major` 且 `status=unresolved` 的 finding，提取关键词。
- 在新版 `task-plan.json` 的 `title`、`description`、`acceptanceCriteria`、`aoPrompt` 中检索覆盖证据。
- 若找不到承接证据，则本地门禁生成 blocking finding。

推荐进一步增强：

- 在 `TaskPlanReviewFinding` 中新增可选字段 `requiredEvidenceKeywords`。
- ClaudeCode 审查时要求每个 blocking/major finding 给出 3 至 8 个必须在任务计划中出现的证据关键词。
- 本地门禁使用该字段做确定性校验。

### 4.5 设计遗留项必须进入任务计划承接表

对 `defer_to_implementation` 的设计审查结果，Codex 生成任务计划时必须输出承接表。可在 task-plan 顶层新增字段：

```ts
implementationFindingTrace: Array<{
  findingId: string;
  severity: "blocking" | "major" | "minor" | "observation";
  taskIds: string[];
  evidence: string;
}>;
```

最低要求：

- blocking、major 必须至少关联一个任务。
- 如果 blocking 被标为 `accepted_as_is`，必须关联 `manual_gate` 或前置校准任务。
- evidence 必须说明落在哪些验收标准或 `aoPrompt` 约束中。

### 4.6 人工门禁不得停留在任务文本

当前样本中 `TASK-002` 是 `manual_gate`，但系统层面仍需要确认：

- `manual_gate` 任务未完成前，后续任务不可派发给 AO。
- `manual_gate` 必须记录人工放行结论。
- 人工放行结论应包含：
  - 是否继续按当前冻结稿实施。
  - 是否转为增量重构版。
  - 后续允许修改范围。
  - 禁止触碰范围。
  - 放行人、放行时间、放行备注。

建议在 AO 派发前增加 `canDispatchTask(taskId)` 校验，确保依赖中的 manual gate 已完成。

## 5. 建议增强项

### 5.1 输出任务计划放行报告

任务计划通过时，生成 `task-plan-approval-report.json` 或写入 workflow 日志，包含：

- 最终审查轮次。
- ClaudeCode 审查结论。
- 本地门禁结论。
- 被承接的设计遗留 finding 列表。
- 被关闭的任务计划审查 finding 列表。
- 仍作为 accepted_as_is 的问题及原因。
- manual_gate 状态。

### 5.2 UI 显示本地门禁阶段日志

在 `/api/governance/plan` 阶段日志中增加：

- “开始本地任务计划门禁校验”。
- “本地门禁通过，共检查 N 项规则”。
- “本地门禁失败，发现 N 个阻断项，已转入整改轮次”。

### 5.3 对样本 workflow 提供重审命令

后续代码整改完成后，应支持对既有 workflow 重新执行任务计划续审，样本路径：

```powershell
pnpm exec tsx src/cli.ts review-task-plan --workflow-id WF-20260630T031508Z --artifact-root "C:\workspace\fast-transport\.ao-control-plane" --project-root "C:\workspace\fast-transport"
```

如果当前 CLI 没有该命令，应补齐或通过 `/api/governance/plan` 复用同一套 runner。

## 6. 测试与验证清单

### 6.1 单元测试

新增或修改以下测试：

- `src/workflow/task-plan-gates.test.ts`
  - 拒绝全默认 `executionPolicy`，如果项目采用差异化策略。
  - 拒绝未知依赖。
  - 拒绝循环依赖。
  - 拒绝缺少 manual gate 的人工确认前置任务。
  - 拒绝缺少 `aoPrompt` 关键上下文的任务。
  - 拒绝跨平台并行任务缺少共享契约冻结。
  - 拒绝未承接 `defer_to_implementation` blocking/major finding 的任务计划。

- `src/workflow/task-plan-review-loop.test.ts`
  - ClaudeCode 返回 `approved`，但本地门禁失败时，不得 approved。
  - 本地门禁失败后，如果还有轮次，应调用 Codex 修订任务计划。
  - 本地门禁失败且达到最大轮次，应 `blockedForHuman=true`。
  - 本地门禁失败 finding 应写入 reviews。

- `src/schemas/execution-policy.test.ts`
  - 验证字段完整性。
  - 验证轮次范围。
  - 验证不同任务类型策略可通过。
  - 验证非法字段被拒绝。

### 6.2 集成测试

新增或修改：

- `src/web/governance-runner.test.ts`
  - `/api/governance/plan` 中 ClaudeCode approved 但本地门禁失败，workflow 不得进入 `executing`。
  - 本地门禁通过后才写入最终 `task-plan.json`。
  - 失败时保留 `task-plan-draft.json` 与完整 `task-plan-reviews.json`。

- `src/web/server.test.ts`
  - 阶段日志包含本地门禁开始、通过、失败信息。
  - 真实 adapter 路径与注入 adapter 路径行为一致。

### 6.3 样本回归验证

使用 `WF-20260630T031508Z` 作为回归样本：

1. 运行任务计划续审。
2. 确认全默认 `executionPolicy` 不再被放行，或已按统一新规则完成差异化。
3. 确认 `DRF-IMPL-001` 至 `DRF-IMPL-006` 都能在任务计划承接表或任务验收标准中找到对应证据。
4. 确认 task-plan review 第 1 轮 unresolved finding 在后续轮次中逐项 addressed 或 accepted_as_is，并有理由。
5. 确认 workflow 只有在 ClaudeCode approved 且本地门禁 passed 时才进入 `executing`。

### 6.4 必跑命令

```powershell
pnpm vitest run src/workflow/task-plan-gates.test.ts
pnpm vitest run src/workflow/task-plan-review-loop.test.ts
pnpm vitest run src/web/governance-runner.test.ts
pnpm vitest run src/web/server.test.ts
pnpm typecheck
pnpm lint
pnpm test
```

## 7. 实施顺序

推荐按以下顺序整改：

1. 统一 `executionPolicy` 规则和 schema。
2. 新增 `task-plan-gates.ts` 本地硬校验器。
3. 在 `task-plan-review-loop.ts` 接入本地门禁。
4. 增加设计遗留项承接表或等效追踪机制。
5. 增加 `/api/governance/plan` 阶段日志。
6. 补齐单元测试和集成测试。
7. 用 `WF-20260630T031508Z` 做样本回归。
8. 更新整改报告，记录最终代码变更与验证结果。

## 8. 通过标准

整改完成后，必须同时满足：

- ClaudeCode 返回 `approved` 但本地门禁失败时，系统不会放行。
- blocking、major unresolved finding 不会无证据消失。
- `defer_to_implementation` 遗留项都有任务承接证据。
- `executionPolicy` 生成、schema、审查、本地门禁规则一致。
- manual gate 未完成时，后续任务不可派发。
- 测试覆盖任务计划误批准场景。
- 全量 `pnpm test`、`pnpm typecheck`、`pnpm lint` 通过。

## 9. 风险说明

本次整改会使任务计划更难通过，但这是预期行为。任务计划进入 AO 派发前，应宁可停在 `blocked_for_human` 或继续整改，也不能在 blocking、major 问题未闭环时进入 `executing`。

对于确实需要保留的 `accepted_as_is` 项，必须提供结构化理由和责任承接任务。否则后续 AO 执行阶段会把设计问题误当作开发自由裁量，继续扩大偏差。
