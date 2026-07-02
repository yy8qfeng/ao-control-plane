# 任务计划生成逻辑完善整改方案

## 1. 背景

以 `C:\workspace\fast-transport\.ao-control-plane\WF-20260630T031508Z` 为样本复核后，当前 `task-plan.json` 的结构质量已经较好：任务数量、依赖图、`manual_gate`、`aoPrompt` 上下文、本地门禁基础规则都能覆盖一部分风险。但样本也暴露出一个更细的问题：任务计划能通过结构校验，并不等价于已经达到“所有任务都可直接实施”的状态。

样本设计稿明确仍是“预实施冻结稿”，并要求先完成 `G0 Repo Reality Check` 与人工复核，再决定是否转为增量重构版实施稿。任务计划虽然设置了 `TASK-001` 和 `TASK-002`，但后续实现任务已经完整展开，容易被误读为“后续代码任务也已经可直接开工”。

因此，本轮整改目标不是推翻现有任务计划审查链路，而是在现有 `task-plan-gates.ts`、`task-plan-review-loop.ts`、`CodexCliAdapter.createTaskPlan()` 的基础上，补齐“设计约束到任务计划”的确定性转译能力。

## 2. 当前主要问题

### 2.1 缺少计划可实施状态分层

当前任务计划只有 `pending` 等任务级状态，缺少计划级别的 readiness 语义。样本实际状态应该是：

- `TASK-001`、`TASK-002` 可立即执行。
- `TASK-003` 之后属于 `G0` 与人工放行后的条件性计划。

但当前 schema 和 UI 只看到最终 `task-plan.json`，容易把条件性后续任务当作全部已进入文件级实施状态。

### 2.2 设计稿强制前置约束没有形成硬门禁

设计稿中“`G0` 前不得进入文件级 AO”“必须由人复核是否转为增量重构版”等约束，目前主要依赖任务文本表达。生成逻辑会创建 `manual_gate`，但本地门禁没有进一步校验：

- 是否所有实现任务都依赖人工复核任务。
- 是否存在 `G0` 后“重规划或设计改写”的回流路径。
- 是否禁止在 `G0` 前派发文件级实现任务。

### 2.3 设计目标覆盖缺口只能靠人工发现

样本中至少有几类设计目标没有被计划充分落地：

- `JDK 21` 标准 `JAR` 的构建、打包、发布验证缺少独立任务。
- 普通共享段路径和文件权限模型缺少实现与测试任务，计划主要覆盖了 RawIp 权限失败。
- `UDP/TCP over IPv4/IPv6` 中的 IPv4/IPv6 维度没有在任务验收中显式出现。
- `OutboundTransport/send` 发送能力预留只在设计冻结任务中出现，缺少是否需要代码级接口落位的判定。

这些属于“设计覆盖矩阵”问题，不能只靠 ClaudeCode 审查自然语言判断。

### 2.4 任务计划审查仍偏通用，缺少领域化规则抽取

现有本地门禁已经覆盖 `executionPolicy`、`aoPrompt`、`manual_gate`、跨平台前置契约、deferred findings 和跨轮 finding 闭环。但它没有从设计稿中抽取以下结构化要求：

- 前置门禁要求。
- 交付物要求。
- 平台和协议矩阵。
- 权限、安全、发布、文档要求。
- 非目标与降级边界。

导致计划可以“看起来完整”，但仍漏掉设计稿中的关键交付物。

## 3. 整改目标

1. 任务计划必须明确区分“当前可执行任务”和“门禁后条件性任务”。
2. 设计稿中的强制前置约束必须转成依赖图和本地门禁，而不是只写在 `aoPrompt` 中。
3. 任务计划生成前应从设计稿抽取“设计覆盖清单”，生成后逐项验证是否承接。
4. 对 `G0` 这类仓库现实校准任务，应支持“校准后重规划”的流程，不应把后续文件级任务伪装成完全冻结。
5. 交付物、平台协议、权限、发布、文档等设计目标必须在任务、验收标准或 `aoPrompt` 中有可追踪证据。
6. 最终 `task-plan.json` 通过时，应能解释“哪些任务可立即派发，哪些任务等待人工门禁，哪些设计目标已被覆盖”。

## 4. 推荐数据模型整改

### 4.1 增加计划级 readiness 字段

建议在 `src/schemas/task-plan.ts` 的顶层 schema 中增加可选字段：

```ts
planReadiness: "directly_implementable" | "gated_implementable" | "calibration_only";
readinessRationale: string;
```

语义：

- `directly_implementable`：所有实现任务都可以按依赖执行，不需要额外设计改写或人工复核。
- `gated_implementable`：计划整体可保留，但部分任务必须等待 `manual_gate` 或校准任务完成。
- `calibration_only`：当前只允许执行校准、复核或设计改写任务，不应派发后续实现任务。

兼容方案：如果短期不想改 schema，可先在本地门禁和 UI 中根据任务文本与依赖图推导 readiness，并生成 `task-plan-approval-report.json`。

### 4.2 增加设计覆盖追踪字段

建议新增顶层字段：

```ts
designCoverageTrace: Array<{
  designRequirementId: string;
  source: "design" | "deferred_finding" | "local_gate";
  category: "prerequisite" | "deliverable" | "platform" | "protocol" | "security" | "performance" | "observability" | "docs" | "non_goal";
  summary: string;
  taskIds: string[];
  evidence: string;
}>;
```

最低要求：

- 每个 `blocking`、`major` 的 deferred finding 必须有 trace。
- 每个设计稿中的强制前置约束必须有 trace。
- 每个交付物类目标必须有 trace。
- `taskIds` 为空时只能用于非目标或明确不纳入一期的边界，且 `evidence` 必须说明原因。

兼容方案：如果不改 schema，可生成旁路文件 `task-plan-coverage-report.json`，并由本地门禁读取。

### 4.3 增加任务执行阶段字段

建议在任务级增加可选字段：

```ts
phase: "calibration" | "planning" | "implementation" | "verification" | "release";
dispatchBlocker?: {
  type: "manual_gate" | "requires_replan" | "platform_unavailable";
  taskIds: string[];
  reason: string;
};
```

用途：

- 标出 `TASK-001` 属于 `calibration`。
- 标出 `TASK-002` 属于 `planning` 或 `manual_gate`。
- 标出后续实现任务被 `TASK-002` 阻塞。
- UI 和 `execute-plan` 可以更清楚地解释为什么某些任务不能派发。

## 5. 生成提示词整改

修改位置：`src/adapters/codex.ts` 的 `formatTaskPlanRules()` 与 `createTaskPlan()`、`reviseTaskPlan()` 提示词。

### 5.1 增加 readiness 生成规则

在 `formatTaskPlanRules()` 中加入：

- 必须判断设计稿是否包含“预实施冻结稿”“仓库现实待校准”“不得进入文件级 AO”“人工复核放行”“需转为增量重构版”等语义。
- 若存在上述语义，任务计划不得标记为 `directly_implementable`。
- 若设计只允许先做仓库校准，则首批可派发任务只能是校准、复核、设计改写或重规划任务。
- 后续实现任务必须显式依赖人工放行任务。
- 若 `G0` 结果可能改变真实模块路径，后续任务的 `aoPrompt` 必须声明“以 G0 输出的真实路径映射为准”。

### 5.2 增加设计覆盖矩阵生成规则

提示词应要求 Codex 在生成任务前先内部抽取以下清单，并在任务计划中覆盖：

- 强制前置门禁：例如 `G0`、人工复核、设计改写。
- 代码交付物：例如 Rust 核心、Java JAR、配置、自检、日志、发布脚本。
- 测试交付物：契约测试、跨进程测试、平台冒烟、性能压测。
- 平台矩阵：Linux、Windows、macOS、Windows 7 条件兼容。
- 协议矩阵：UDP、TCP、IPv4、IPv6、RawIp 默认关闭。
- 权限安全：共享段目录、文件权限、Windows ACL、RawIp 权限失败。
- 性能口径：Linux `publish_timestamp_ns - recv_timestamp_ns`、`1300B` 样本、稳态和突发工况。
- 可观测性：stats、health、`clock_domain`、结构化日志、报告产物。
- 发布文档：Java JAR 发布、调优手册、权限文档、指标解释。

生成后必须做到：

- 每个清单项至少落入一个任务标题、描述、验收标准或 `aoPrompt`。
- 如果清单项被判定为非一期范围，必须落入文档或边界验证任务。
- 不能只在前置设计任务中“冻结”，却没有后续实现或验证任务，除非设计明确只要求接口预留且无代码落位。

### 5.3 增加 `G0` 后重规划规则

针对样本这种“仓库现实未实读”的设计，提示词应要求生成以下路径之一：

1. 只生成 `G0` 与人工复核任务，`planReadiness=calibration_only`。
2. 生成完整条件性后续任务，但必须：
   - `planReadiness=gated_implementable`。
   - 所有实现、测试、发布任务依赖人工复核任务。
   - 增加“G0 后任务计划重审或设计改写”任务。
   - 明确 `G0` 发现存量冲突时，后续任务不得直接执行。

推荐采用第 2 种，便于用户提前看到实施路线，但 UI 和派发逻辑必须清楚标记它是条件性计划。

### 5.4 增加任务缺口修复规则

提示词应明确：当设计稿包含以下关键词或等价语义时，计划必须生成对应任务或验收标准。

| 设计语义 | 必须生成的任务或验收 |
| --- | --- |
| `JDK 21`、`JAR`、“依赖调用” | Java 构建、JAR 打包、发布验证、示例依赖验证 |
| `/dev/shm`、`ProgramData`、`0700`、`0600`、`ACL` | 共享段路径和权限实现、跨平台权限测试 |
| `IPv4/IPv6` | UDP/TCP 的 IPv4 和 IPv6 冒烟或验收标准 |
| `OutboundTransport`、`send`、“发包能力预留” | 发送接口预留落位或明确“不做代码落位”的设计复核任务 |
| `RawIpAdapter` | 默认关闭、feature gate、权限失败错误契约和测试 |
| `clock_domain` | 控制块、stats、报告和文档贯通任务 |
| `1300B` | 配置校验、性能报告、文档中说明它只是样本 |

## 6. 本地门禁整改

修改位置：`src/workflow/task-plan-gates.ts`。

### 6.1 新增 `validateReadinessAndG0Gate()`

规则：

- 如果设计稿或任务计划中出现 `G0`、`仓库现实校准`、`预实施冻结稿`、`不得进入文件级`、`人工复核放行` 等语义，则计划必须存在人工门禁任务。
- 所有 `implementation`、`refactor`、平台实现、发布任务必须直接或间接依赖人工门禁任务。
- 如果计划没有 readiness 字段，则本地门禁根据任务内容推导 readiness，并在审批报告中输出。
- 如果存在需要 `G0` 的语义，但实现任务没有被门禁阻塞，生成 blocking finding。

### 6.2 新增 `validateDesignCoverageTrace()`

输入需要增加 `approvedDesign`：

```ts
validateTaskPlanApprovalGate({
  workflowId,
  approvedDesign,
  deferredFindings,
  plan,
  previousReviews
});
```

校验逻辑：

- 从 `approvedDesign` 中抽取关键设计条目。
- 对每个条目在 `plan.tasks` 和 `designCoverageTrace` 中查找证据。
- 对缺失的强制前置、交付物、平台协议、权限、安全、发布条目生成 blocking 或 major finding。

第一版可以用关键词规则，后续再演进为结构化设计稿解析。

### 6.3 新增 `validateArtifactDeliverables()`

至少覆盖：

- 设计提到 `JAR` 时，必须有 Java 构建、打包或发布验证任务。
- 设计提到权限模型时，必须有共享段路径和权限实现或验证任务。
- 设计提到 IPv4/IPv6 时，必须在平台后端或冒烟任务中出现 IPv4 与 IPv6。
- 设计提到发包预留时，必须有代码落位任务或显式的设计复核结论。

### 6.4 新增 `validateConditionalPlanDispatchability()`

该校验不一定阻断 `task-plan.json` 生成，但必须阻断错误派发：

- `calibration_only` 只能派发校准和复核任务。
- `gated_implementable` 中，未通过人工门禁的后续任务不可派发。
- 如果 `manual_gate` 任务完成结果要求“改写设计”或“重规划”，后续旧任务应进入暂停或失效状态。

## 7. 审查循环整改

修改位置：`src/workflow/task-plan-review-loop.ts`。

现有逻辑已经在 ClaudeCode 返回 `approved` 后调用本地门禁。需要进一步调整：

1. 将 `approvedDesign` 传入 `validateTaskPlanApprovalGate()`，使本地门禁能做设计覆盖校验。
2. 本地门禁失败后，生成的 local-gate review 应区分：
   - `blocking`：必须整改。
   - `major`：必须整改或给出 accepted_as_is 依据。
   - `warning`：可进入报告，但不阻断。
3. 当本地门禁发现计划只达到 `calibration_only` 时，不应标记 workflow 失败；应允许输出 `task-plan.json`，但执行层只能派发校准任务。
4. 当本地门禁发现计划声称 `directly_implementable` 但实际存在 `G0` 门禁时，应转为 `changes_requested`。

## 8. 执行派发整改

修改位置：`src/workflow/plan-execution.ts` 和 Web UI 中的派发逻辑。

### 8.1 派发前检查 readiness

执行前增加统一函数：

```ts
canDispatchTask(plan, task, completedTasks, releasedManualGates, approvalReport)
```

必须检查：

- 普通依赖是否完成。
- `manual_gate` 是否已由用户放行。
- 任务是否处于当前 readiness 允许的 phase。
- 若 `G0` 复核结果要求重规划，旧实现任务不可继续派发。

### 8.2 人工放行记录结构化

放行 `manual_gate` 时，建议记录：

```ts
{
  "taskId": "TASK-002",
  "decision": "continue_current_plan" | "requires_design_rewrite" | "requires_replan" | "blocked",
  "allowedScopes": ["..."],
  "forbiddenScopes": ["..."],
  "comment": "...",
  "releasedAt": "...",
  "releasedBy": "human"
}
```

如果选择 `requires_design_rewrite` 或 `requires_replan`，系统应阻断旧后续实现任务，并提示用户重新生成任务计划。

## 9. UI 与报告整改

修改位置：`src/web/ui.ts`、`src/web/workflow-jobs.ts`、`src/web/governance-runner.ts`。

### 9.1 增加计划状态展示

UI 中应展示：

- 计划状态：直接可实施、门禁后可实施、仅校准。
- 当前可派发任务数量。
- 等待人工门禁的任务数量。
- 被门禁阻塞的后续任务数量。
- 设计覆盖缺口数量。

### 9.2 生成审批报告

建议新增落盘文件：

- `task-plan-approval-report.json`
- `task-plan-coverage-report.json`

报告内容：

- ClaudeCode 最终审查结论。
- 本地门禁结论。
- 推导出的 readiness。
- 当前可派发任务列表。
- 被 manual gate 阻塞的任务列表。
- 设计覆盖追踪表。
- accepted_as_is 的问题及理由。

### 9.3 改善文案

避免使用“任务计划已达到可实施状态”这类单一文案。建议改为：

- “任务计划已生成，当前仅允许执行仓库校准与人工复核任务。”
- “任务计划已通过门禁，但后续实现任务需等待人工放行。”
- “任务计划已达到直接实施状态。”

## 10. 测试整改清单

### 10.1 `task-plan-gates.test.ts`

新增用例：

- 设计含 `G0 Repo Reality Check`，但实现任务未依赖人工门禁时，拒绝。
- 设计含“预实施冻结稿”，计划标记为 `directly_implementable` 时，拒绝。
- 设计含 `JDK 21 JAR`，计划缺少 JAR 构建或发布验证任务时，拒绝。
- 设计含 `0700`、`0600`、`ACL`，计划缺少共享段权限实现或验证任务时，拒绝。
- 设计含 `IPv4/IPv6`，计划缺少 IPv6 验收证据时，拒绝。
- 设计含 `OutboundTransport/send`，计划既无接口落位也无明确非落位复核时，拒绝或 warning。
- 条件性计划中，所有实现任务直接或间接依赖 `manual_gate` 时，通过。

### 10.2 `task-plan-review-loop.test.ts`

新增用例：

- ClaudeCode 返回 `approved`，但设计覆盖门禁失败，应继续调用 Codex 修订。
- 门禁判断为 `calibration_only` 时，可以输出计划，但 `approved` 结果应携带 readiness。
- 本地门禁发现 JAR 发布缺口时，下一轮计划补齐对应任务后通过。

### 10.3 `plan-execution.test.ts`

新增用例：

- `gated_implementable` 计划中，未放行 `manual_gate` 时只派发 `G0` 和复核任务。
- 人工放行后，后续依赖满足的任务才可派发。
- 人工结论为 `requires_replan` 时，旧实现任务不可派发。

### 10.4 Web 集成测试

新增用例：

- UI 能显示 `calibration_only`、`gated_implementable`、`directly_implementable`。
- 点击“派发执行”时，门禁后任务不会被误派发。
- 放行门禁时必须记录结构化放行结论。

## 11. 建议实施顺序

1. 扩展 `validateTaskPlanApprovalGate()` 输入，加入 `approvedDesign`。
2. 在 `task-plan-gates.ts` 中实现 `G0`、readiness、设计覆盖、交付物覆盖校验。
3. 修改 `CodexCliAdapter` 任务计划生成提示词，要求输出 readiness 与覆盖证据。
4. 决定是否扩展 `taskPlanSchema`；若暂不扩展，先通过审批报告旁路落盘。
5. 修改任务计划审查循环，使本地门禁失败能驱动下一轮 Codex 修订。
6. 修改派发逻辑，禁止门禁未放行的后续实现任务被执行。
7. 补齐 UI 状态文案和审批报告展示。
8. 用 `WF-20260630T031508Z` 样本做回归，确认计划状态被识别为 `gated_implementable` 或 `calibration_only`，而不是直接可实施。

## 12. 验收标准

整改完成后，应满足：

- 设计稿要求先做 `G0` 时，任务计划不会被判定为全部直接可实施。
- 所有后续实现任务都被人工复核任务阻塞，或计划被标记为仅校准。
- `JDK 21 JAR`、共享段权限、IPv4/IPv6、发包预留等设计目标不会无声遗漏。
- 任务计划通过后，系统能输出机器可读的 readiness 与设计覆盖报告。
- `execute-plan` 不会派发尚未满足 `manual_gate` 的实现任务。
- 本地门禁失败时，即使 ClaudeCode 返回 `approved`，系统也不会直接进入错误实施状态。

## 13. 最小可行版本

如果希望先快速修复风险，建议先做以下最小闭环：

1. 不改 schema，只新增 `task-plan-approval-report.json`。
2. `validateTaskPlanApprovalGate()` 增加 `approvedDesign` 入参。
3. 用关键词规则实现四个硬校验：
   - `G0` / 预实施冻结稿门禁校验。
   - `JDK 21 JAR` 覆盖校验。
   - 共享段权限覆盖校验。
   - IPv4/IPv6 覆盖校验。
4. 修改 `formatTaskPlanRules()`，要求 Codex 补齐上述覆盖。
5. 修改执行派发逻辑，确保 `manual_gate` 未放行前不派发后续实现任务。

这个最小版本即可解决样本暴露出的主要误判：任务计划可以作为路线图保留，但不会被系统或用户误认为所有任务已经直接可实施。
