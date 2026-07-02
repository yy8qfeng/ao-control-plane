# 任务计划模型输出归一化问题与统一整改方案

## 背景

任务计划生成流程近期多次出现模型输出字段与本地严格 schema 不匹配，导致流程在进入任务计划审查、本地门禁和人工阻塞路径前直接失败。

已出现的典型问题包括：

- `aoRole` 输出为 `human-reviewer`，但本地枚举只接受 `reviewer` 等固定角色。
- `aoRole` 输出为 `release`，但 `release` 是阶段语义，不是 AO 角色。
- `task.type` 输出为 `calibration`，但本地枚举只接受 `design`、`implementation`、`test`、`refactor`、`review`、`docs`、`verification`。
- `designCoverageTrace[].requirementId` 缺失，触发 `invalid_type`。
- `executionPolicy` 缺少 `maxQaRounds`，同时混入 `policyRationale` 等说明字段，触发策略对象严格校验失败。

这些问题不是业务任务不可实施，而是模型输出格式与本地严格执行契约之间缺少稳定适配层。继续逐个补丁只能降低单点失败率，不能从根上避免流程被底层 schema 错误打断。

## 已知报错归类

### 1. 枚举值别名或跨字段错位

代表问题：

```text
Invalid enum value. Expected 'architect' | 'reviewer' | ... | 'backend', received 'human-reviewer'
```

```text
Invalid enum value. Expected 'architect' | 'reviewer' | ... | 'backend', received 'release'
```

问题性质：

- `human-reviewer` 是模型按自然语言生成的角色别名，应归一为 `reviewer`。
- `release` 不是角色别名，而是阶段语义错填到了 `aoRole`。
- `calibration`、`planning`、`release` 等也可能被错填到 `task.type`。

通用处理：

- Raw schema 宽松接收非标准枚举值。
- Normalizer 基于显式映射表和上下文推断纠偏。
- 角色别名可直接归一，例如 `human-reviewer -> reviewer`。
- 跨字段错位必须同时修正字段，例如 `aoRole=release -> phase=release + aoRole=docs/qa/reviewer`。
- 无法确定语义时进入 schema repair review，而不是抛出 enum 异常。

### 2. 必填结构字段缺失

代表问题：

```json
{
  "code": "invalid_type",
  "expected": "string",
  "received": "undefined",
  "path": ["designCoverageTrace", 0, "requirementId"],
  "message": "Required"
}
```

问题性质：

- 模型知道要写覆盖追踪，但没有使用本地严格字段名。
- 可能输出了 `id`、`key`、`requirementKey`，也可能只写了 `requirement` 文本。
- `designCoverageTrace` 是审批证据，不是执行任务主体；无法识别时不能伪造覆盖，也不应让流程直接异常退出。

通用处理：

- Raw schema 允许 trace 缺少严格字段。
- Normalizer 先读取字段别名。
- 字段别名不存在时，从 `requirement`、`title`、`description` 推断已知 requirementId。
- 无法推断时丢弃该 trace，并记录到 `droppedEntries`。
- 丢弃 trace 不视为覆盖成功，后续本地门禁仍应按缺口处理。

### 3. 嵌套对象字段污染或缺省

代表问题：

```text
executionPolicy must be complete and valid; invalid or missing fields: maxQaRounds, policyRationale
```

问题性质：

- `executionPolicy` 是执行策略对象，本地只允许固定字段。
- 模型容易遗漏字段，例如 `maxQaRounds`。
- 模型也容易混入解释字段，例如 `policyRationale`、`rationale`、`reason`。
- 这类问题不能通过放宽业务 schema 解决，否则会削弱执行策略约束。

通用处理：

- Raw schema 允许 `executionPolicy` 是部分对象，并允许解释字段存在。
- Normalizer 删除解释字段。
- 缺失字段按任务类型默认策略补全。
- 非法轮次值按任务类型默认值回落。
- 对 implementation/refactor，归一化层应恢复本地强制完整策略，并记录归一化变更；strict schema 仍作为最终防线。

## 当前链路问题

当前主要链路为：

```text
模型原始输出
  ↓
extract JSON
  ↓
normalizeCodexTaskPlanOutput（局部补丁）
  ↓
taskPlanSchema.parse（严格 schema）
  ↓
失败则流程异常中断
```

主要缺陷：

1. **宽松接收层缺失**  
   模型输出具有自然语言不稳定性，但当前没有独立 `rawTaskPlanSchema` 承接常见变体。

2. **归一化逻辑不集中**  
   当前兼容逻辑散落在 `src/adapters/codex.ts`，难以被 CLI、Web artifact 读取、历史 draft/final 继续规划等入口复用。

3. **schema 错误直接变成流程失败**  
   可修复的模型格式问题应该进入 schema repair 或 blocked artifact，而不是直接让用户看到底层 enum 或 invalid_type。

4. **归一化过程不可审计**  
   当前缺少统一记录：原始值是什么、归一化成什么、丢弃了什么、strict schema 是否仍失败。

5. **artifact 版本关系不清晰**  
   归一化报告、审批报告、draft plan、final plan 之间缺少显式 round/version 关联。

## 目标

统一整改后，任务计划生成应满足：

1. 模型常见字段变体不会导致流程直接异常退出。
2. 所有模型输出先进入宽松 schema，再经过确定性归一化，最后进入严格业务 schema。
3. 可归一化问题自动修复，并记录归一化报告。
4. 不可归一化问题进入 schema repair review；多轮仍失败时进入 `blocked_for_human`。
5. Codex CLI、Placeholder、Web artifact、CLI 读取历史计划等入口复用同一套 normalizer。
6. 用户看到的是“任务计划待整改”或“人工阻塞”，不是底层 schema enum 报错。

## 建议架构

新增统一 normalizer 模块：

```text
src/workflow/task-plan-normalizer.ts
src/workflow/task-plan-normalizer.test.ts
```

主链路调整为：

```text
模型原始输出
  ↓
extract JSON
  ↓
rawTaskPlanSchema.safeParse（宽松接收）
  ↓
normalizeRawTaskPlan（确定性归一化）
  ↓
taskPlanSchema.safeParse（严格校验）
  ↓
成功：进入任务计划审查与本地门禁
失败：生成 schema repair review，要求模型修复
  ↓
仍失败：blocked_for_human，并落 raw output、归一化报告、schema 错误
```

建议 API：

```ts
normalizeTaskPlanModelOutput(raw, {
  workflowId,
  round,
  source: "codex" | "artifact" | "cli"
}): {
  plan?: TaskPlan;
  report: TaskPlanNormalizationReport;
  rawValue?: unknown;
}
```

## Raw Schema 边界

`rawTaskPlanSchema` 只用于接收模型输出，不作为业务执行契约。

Raw schema 应保留核心必填字段：

- `workflowId`
- `title`
- `tasks`
- `tasks[].taskId`
- `tasks[].workflowId`
- `tasks[].title`
- `tasks[].description`
- `tasks[].acceptanceCriteria`
- `tasks[].aoPrompt`

Raw schema 应放宽：

- `task.type`：允许标准值及 `calibration`、`planning`、`release`、`validation`、`verify`、`qa`。
- `task.phase`：允许标准值及常见别名。
- `aoRole`：允许标准值、角色别名和阶段误填值。
- `executionPolicy`：允许部分对象和解释字段。
- `designCoverageTrace`：允许字段别名和缺字段。

Raw schema 不应放宽到任意对象都通过；核心任务结构缺失时应记为 `raw_failed`。

## 归一化规则

### 1. 任务类型归一化

建议建立显式映射表：

```ts
const taskTypeAliases = {
  calibration: { type: "review", phase: "calibration" },
  planning: { type: "design", phase: "planning" },
  release: { type: "verification", phase: "release" },
  validation: { type: "verification" },
  verify: { type: "verification" },
  qa: { type: "test" }
};
```

### 2. AO 角色别名归一化

```ts
const aoRoleAliases = {
  "human-reviewer": "reviewer",
  "human-review": "reviewer",
  "manual-reviewer": "reviewer",
  "senior-backend": "backend-senior",
  "backend-lead": "backend-senior",
  "senior-frontend": "frontend-senior"
};
```

### 3. 跨字段错位归一化

```ts
const phaseLikeValues = new Set([
  "calibration",
  "planning",
  "implementation",
  "verification",
  "release"
]);
```

归一化顺序：

1. 如果 `aoRole` 是阶段值，先写入 `phase`。
2. 优先从 `title`、`description`、`aoPrompt` 提取显式角色线索。
3. 无显式线索时按 `type` 和 `phase` 推断。
4. 记录归一化变更，不静默吞掉。

角色推断建议：

```ts
function inferAoRoleFromTask(task) {
  const text = `${task.title}\n${task.description}\n${task.aoPrompt}`.toLowerCase();
  if (/review|审核|复核|放行/.test(text)) return "reviewer";
  if (/design|architecture|架构|设计/.test(text)) return "architect";
  if (/test|qa|verify|verification|验证|测试|冒烟|回归/.test(text)) return "qa";
  if (/docs|doc|文档|release note|发布说明/.test(text)) return "docs";

  if (task.phase === "release") return "docs";
  if (task.phase === "verification" || task.type === "test" || task.type === "verification") return "qa";
  if (task.phase === "planning" || task.type === "design") return "architect";
  if (task.dependencyCondition === "manual_gate" || task.type === "review") return "reviewer";
  if (task.type === "implementation" || task.type === "refactor") return "backend-senior";
  return "reviewer";
}
```

### 4. 设计覆盖归一化

- `requirementId` 缺失时，优先从 `id`、`key`、`requirementKey` 读取。
- 仍缺失时，从 `requirement`、`title`、`description` 推断已知 requirementId：
  - `g0-readiness-gate`
  - `java-jar-delivery`
  - `shared-segment-permission`
  - `ipv6-support`
  - `outbound-transport-reservation`
- 无法识别的 trace 丢弃并记录。
- `evidenceTaskIds` 只保留真实存在的 taskId。
- `evidenceTaskIds=[]` 的 trace 可以保留，但不得被 `hasStructuredCoverage()` 视为 covered 证据。

### 5. executionPolicy 归一化

职责分工：

- Normalizer 负责：补缺、剔除解释字段、非法枚举或轮次回落、恢复 implementation/refactor 强制策略。
- Strict schema 负责：最终强制完整性校验，防止 normalizer 漏洞。

具体规则：

- 删除 `policyRationale`、`rationale`、`reason`。
- `maxQaRounds`、`maxReviewRounds` 非 `1 | 2 | 3` 时回落到任务类型默认值。
- 缺字段时按任务类型默认值补全。
- implementation/refactor 如果输出 `qaRequired=false`、`reviewerRequired=false`、`requirePrOrRp=false` 或轮次小于 3，归一化恢复为完整策略，并记录变更。
- design/review/docs/test/verification 可按任务类型默认策略降低不适用环节。

## Schema Repair Review 路径

新增 `schemaRepairRounds` 配置，建议默认值为 `2`，与 `maxTaskPlanReviewRounds` 独立计数。

处理流程：

1. `rawTaskPlanSchema.safeParse` 失败：生成 schema repair prompt，要求 Codex 修复原始 JSON 的结构字段。
2. `normalizeRawTaskPlan` 后 strict parse 失败：生成 schema repair prompt，列出 strict schema 错误和归一化报告。
3. schema repair 成功：进入 ClaudeCode 任务计划审查和本地门禁。
4. schema repair 轮次耗尽：生成结构化 local review finding，并进入 `blocked_for_human`。

schema repair 不应消耗普通任务计划审查轮次，避免格式错误挤占业务审查预算。

## 归一化报告

新增报告：

```text
task-plan-normalization-report-{round}.json
```

建议字段：

```json
{
  "workflowId": "WF-...",
  "round": 1,
  "generatedAt": "ISO timestamp",
  "source": "codex",
  "rawSchemaErrors": [],
  "changes": [
    {
      "path": "tasks.0.type",
      "from": "calibration",
      "to": "review",
      "reason": "calibration is a phase; review is the closest supported task type"
    }
  ],
  "droppedEntries": [
    {
      "path": "designCoverageTrace.0",
      "reason": "requirementId cannot be inferred"
    }
  ],
  "strictSchemaErrors": [],
  "outcome": "passed"
}
```

`outcome` 取值：

- `passed`
- `raw_failed`
- `strict_failed`

版本关系：

- 每一轮任务计划生成或修复都生成一个归一化报告。
- 归一化报告的 `round` 必须与本轮 plan/review round 对齐。
- `task-plan-approval-report.json` 应引用最近一次归一化报告路径或 round。
- `workflow.json` 建议新增：

```json
{
  "lastNormalization": {
    "round": 1,
    "reportPath": "task-plan-normalization-report-1.json",
    "changeCount": 3,
    "outcome": "passed"
  }
}
```

Web UI 建议在 task plan detail 页展示：

- 最近一次归一化 outcome。
- 归一化变更数量。
- 丢弃条目数量。
- 报告 JSON 链接。

## 入口迁移范围

必须覆盖以下入口：

1. `src/adapters/codex.ts` 的 `parseTaskPlanOutput()`。
2. `src/workflow/task-plan-review-loop.ts` 的 initial/revised plan 入口。
3. `src/workflow/run-workflow.ts` 的 plan loop 出口。
4. `src/web/artifact-store.ts` 的 `readTaskPlan()`。
5. `src/cli.ts` 中读取 task-plan 的入口。
6. 历史 `task-plan-draft.json` 和 `task-plan.json` 继续规划入口。

入口原则：

- 模型输出必须走 raw schema + normalizer。
- 历史 artifact 至少必须 strict parse；如果启用兼容模式，也应走 normalizer 并落报告。
- Web 执行入口不得直接 `JSON.parse(raw) as TaskPlan` 后派发。

## 与本地门禁的关系

归一化只解决“模型输出格式接入”，不替代本地门禁。

归一化后仍必须执行：

- executionPolicy 差异化校验。
- aoPrompt 上下文校验。
- G0 / manual_gate 依赖校验。
- 设计覆盖校验。
- 历史 unresolved finding 闭环校验。

证据链应为：

```text
raw output
  ↓
normalization report
  ↓
strict task plan
  ↓
local gate approval report
  ↓
task plan review / blocked_for_human
```

## 建议整改步骤

1. **抽取 normalizer 模块**  
   新建 `src/workflow/task-plan-normalizer.ts`，迁出现有 `normalizeCodex*` 逻辑。

2. **新增 raw schema**  
   定义 `rawTaskPlanSchema`，边界按本文 Raw Schema 章节执行。

3. **补齐归一化规则**  
   覆盖 type alias、aoRole alias、跨字段错位、designCoverageTrace、executionPolicy。

4. **改造 Codex 输出解析链路**  
   `parseTaskPlanOutput()` 改为 extract JSON → raw parse → normalize → strict parse。

5. **新增归一化报告**  
   输出 `task-plan-normalization-report-{round}.json`，并在审批报告或 workflow 中记录引用。

6. **新增 schema repair review**  
   `runTaskPlanReviewLoop` 增加 `schemaRepairRounds`，并新增 schema repair prompt。

7. **改造历史入口**  
   覆盖 CLI、ArtifactStore、Web 执行入口和历史 draft/final 继续规划入口。

8. **Web UI 展示归一化摘要**  
   与门禁 finding 分开展示，避免把格式纠偏误读为业务审批问题。

9. **补充测试矩阵**  
   新增 normalizer 单元测试、Codex 解析测试、review loop schema repair 测试、artifact 入口回归测试。

10. **性能影响确认**  
   归一化为 O(tasks × fields)，相对 Codex 调用耗时可忽略；仍应在报告中记录无明显性能影响。

## 测试矩阵

必须覆盖：

- `type=calibration`
- `type=planning`
- `type=release`
- `type=validation`
- `type=verify`
- `type=qa`
- `aoRole=human-reviewer`
- `aoRole=senior-backend`
- `aoRole=backend-lead`
- `aoRole=release`
- `aoRole=planning`
- `aoRole=calibration`
- `aoRole` 为阶段值时补 `phase` 并推断合法角色
- `designCoverageTrace.requirementId` 缺失但可由别名补齐
- `designCoverageTrace.requirementId` 缺失但可由文本推断
- `designCoverageTrace.requirementId` 无法推断时丢弃
- `evidenceTaskIds` 引用不存在任务
- `designCoverageTrace.evidenceTaskIds=[]`
- `executionPolicy` 含 `policyRationale`
- `executionPolicy.maxQaRounds` 缺失
- `executionPolicy.maxReviewRounds` 非法
- `executionPolicy.qaRequired=false` 弱化 implementation 策略
- 多个错误同时出现
- raw schema 失败进入 schema repair
- strict schema 失败进入 schema repair
- schema repair 第二轮成功
- schema repair 轮次耗尽后 blocked_for_human
- `artifact-store.readTaskPlan()` 不再绕过 schema
- CLI 读取历史 task plan 失败时输出可解释错误

## 不采纳项与边界

### 不采纳：implementation/refactor 弱化策略只交给 strict schema 报错

审查报告提出一种分工：归一化层只补缺和剔除，implementation/refactor 弱化字段留给 strict schema 报错。

本方案不采纳该边界，原因：

- `qaRequired=false`、`reviewerRequired=false`、`requirePrOrRp=false`、轮次小于 3 对 implementation/refactor 来说语义确定，恢复为完整策略没有歧义。
- 本次整改目标是减少模型格式或策略对象生成偏差导致的流程中断；已知可确定恢复的弱化字段应归一化修复并记录。
- strict schema 仍保留最终兜底，防止 normalizer 漏洞或未知弱化形式。

边界：

- 只对 implementation/refactor 恢复强制完整策略。
- design/review/docs/test/verification 不强行恢复到 implementation 策略。
- 所有恢复行为必须进入归一化报告。

## 当前临时状态

当前代码已存在部分局部兼容：

- `human-reviewer` 归一为 `reviewer`。
- `type=calibration` 归一为 `type=review`、`phase=calibration`。
- `designCoverageTrace` 部分字段别名和缺失字段已做兼容。
- `executionPolicy` 中部分解释字段已剔除。
- rejected draft 优先级和 stale final 删除逻辑已修复，避免 draft/report 与 final plan 错位。

这些修复能降低当前失败率，但仍不是最终形态。后续应按本文方案统一抽象，避免继续在 `CodexCliAdapter` 中堆积临时补丁。

## 最终判定标准

完成统一整改后，应满足：

1. 模型输出常见枚举别名不再导致流程直接失败。
2. 模型输出跨字段错位能被归一化或进入 schema repair。
3. 所有归一化行为有测试覆盖。
4. 不可归一化问题能落成结构化 artifact。
5. schema repair review 轮次可被触发、消费和回放。
6. `workflow.json` 能引用最近一次归一化报告。
7. `task-plan-normalization-report-*.json` 与 plan/review round 对齐。
8. 任务计划审批报告、归一化报告、最终 plan 或 draft plan 之间 taskId 一致。
9. Web UI 区分展示归一化变更和本地门禁 finding。
10. 用户看到的是“任务计划待整改”或“人工阻塞”，而不是底层 schema enum 报错。
