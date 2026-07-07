# 连续任务调度器 AO 结果语义化设计方案

## 1. 背景

当前连续任务调度器主要依赖 AO session 的运行状态推进任务，例如 `completed`、`mergeable`、`stuck`、`needs_input`。这在普通实现任务中基本可用，但在 review、manual_gate、QA verdict 等治理任务中存在明显缺口：

1. AO 的 session 状态不是业务结论。`needs_input` 可能表示缺少权限、缺少结构化门禁决策、上游需要返工，也可能只是 AO 没有按约定写控制面产物。
2. AO 的自然语言 report 不能直接驱动调度器。类似“建议由 ft-9 修复 B1-B4 后直接复核通过”的内容，如果没有结构化 `decision` 或 `rework_request` 产物，调度器无法安全判断返工目标、阻断项和恢复路径。
3. manual_gate 当前缺少统一三态结果闭环。`approved` 已有部分支持，但 `rework_required`、`blocked`、`needs_structured_decision` 没有形成完整调度语义。
4. 页面展示偏执行状态，缺少“AO 业务结论”“返工目标”“缺失结构化产物”的直接解释，用户只能去 AO 面板里读自然语言。

因此，本次改造不应只针对 `AO reviewer needs_input` 打补丁，而应将 AO 结果消费升级为“运行状态 + 结构化业务结论 + 产物契约”的统一判定模型。

## 2. 设计目标

本次改造目标如下：

1. 调度器不再直接把 AO session 状态等同于任务业务结果。
2. 引入统一 AO 结果语义模型，将 `completed`、`needs_input`、`stuck`、`failed` 等状态归一化为可调度的业务 outcome。
3. manual_gate、review、QA verdict 等治理任务必须通过结构化产物表达通过、返工、阻断。
4. 对 `needs_input` 做分层处理：先尝试读取结构化产物和 AO report 语义，再决定是返工、等待结构化决策、人工阻断，还是系统失败。
5. 页面必须清楚展示当前任务为什么停止、需要谁修复、缺哪个产物、下一步能做什么。
6. 后续任务继续使用现有 artifact contract registry 和 output reconcile 能力，不引入额外 agent。

## 3. 非目标

以下内容不在本次范围内：

1. 不自动让模型修改任务计划。需要改变依赖图或任务粒度时，仍走现有重规划流程。
2. 不从自然语言 report 中直接生成正式门禁决策。自然语言只能作为诊断信息，不能替代结构化产物。
3. 不把所有 AO 状态都降级为可继续。真正失败、超时、产物冲突、合约违规仍必须阻断。
4. 不改变 AO 的 worktree 隔离模型。调度器继续通过 control-plane artifactDir 作为权威证据目录。

## 4. 核心概念

### 4.1 AO 运行状态

AO 运行状态来自 `ao session ls` 或 AO report，例如：

- `working`
- `completed`
- `mergeable`
- `merged`
- `stuck`
- `failed`
- `needs_input`
- `idle`

该状态只说明 AO session 的运行情况，不直接说明任务是否完成、门禁是否通过、上游是否需要返工。

### 4.2 AO 业务结果

新增统一业务结果模型 `AoTaskOutcome`：

```ts
type AoTaskOutcome =
  | {
      kind: "completed";
      source: "ao_status" | "artifact" | "report";
      message?: string;
    }
  | {
      kind: "approved";
      source: "artifact";
      decisionPath: string;
      flagPath?: string;
    }
  | {
      kind: "rework_required";
      source: "artifact";
      failureKind: "manual_gate_rework_required";
      decisionPath: string;
      reworkRequestPath?: string;
      targetTaskIds: string[];
      findings: AoOutcomeFinding[];
      message?: string;
    }
  | {
      kind: "blocked";
      source: "artifact" | "report" | "ao_status";
      reason: string;
      findings?: AoOutcomeFinding[];
    }
  | {
      kind: "needs_structured_decision";
      source: "ao_status" | "report";
      failureKind: "ao_task_needs_structured_decision";
      requiredOutputs: string[];
      reportSummary?: string;
      message: string;
    }
  | {
      kind: "needs_human";
      source: "ao_status" | "report";
      failureKind: "ao_task_needs_input";
      reason: string;
    }
  | {
      kind: "invalid";
      reason: string;
      details?: unknown;
    };
```

`AoOutcomeFinding` 结构：

```ts
interface AoOutcomeFinding {
  id: string;
  severity: "blocking" | "major" | "minor";
  summary: string;
  targetTaskId?: string;
  requiredAction?: string;
  evidencePaths?: string[];
}
```

### 4.3 控制面产物

对于 manual_gate/review 任务，必须产出主 decision JSON：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "taskId": "TASK-009",
  "decision": "approved",
  "source": "ao_review",
  "aoSessionId": "ft-11",
  "rationale": "复核通过",
  "reviewerIndependence": {
    "reviewerSessionId": "ft-11",
    "producerSessionId": "ft-9"
  },
  "findings": []
}
```

当 `decision=rework_required` 时：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "taskId": "TASK-009",
  "decision": "rework_required",
  "source": "ao_review",
  "aoSessionId": "ft-11",
  "rationale": "共享抽象冻结存在阻断项，需要 TASK-008 返工。",
  "reviewerIndependence": {
    "reviewerSessionId": "ft-11",
    "producerSessionId": "ft-9"
  },
  "targetTaskIds": ["TASK-008"],
  "findings": [
    {
      "id": "B1",
      "severity": "blocking",
      "summary": "transport stats 字段与 IPC stats 边界描述冲突。",
      "targetTaskId": "TASK-008",
      "requiredAction": "由 TASK-008 producer 更新 transport_contract_freeze.json 和 markdown。"
    }
  ]
}
```

主 decision JSON 是调度器解析 `rework_required` 的主来源，必须包含 `targetTaskIds` 和 `findings`。如果任务有独立 rework request artifact，则作为附属产物同时写入；当主 decision JSON 缺少返工明细但 rework request artifact 存在且合法时，outcome resolver 可读取附属产物补齐诊断信息，但不能用附属产物替代主 decision 的 `decision=rework_required`。

如果任务有独立 rework request artifact，则还应写：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "sourceTaskId": "TASK-009",
  "targetTaskIds": ["TASK-008"],
  "reason": "manual_gate_rework_required",
  "findings": []
}
```

## 5. 新增模块

### 5.1 `src/workflow/ao-task-outcome.ts`

新增 AO 结果解析模块，统一处理 session 状态、report、产物和合约。

核心接口：

```ts
export async function resolveAoTaskOutcome(input: {
  plan: TaskPlan;
  task: ExecutionTask;
  taskState: ExecutionTaskState;
  state: ExecutionState;
  session?: AoSessionSnapshot;
  artifactDir: string;
  manualGateMode?: "manual_approve" | "ao_review";
}): Promise<AoTaskOutcome>;
```

解析优先级：

1. 结构化控制面产物。
2. AO report 中已经结构化的字段。
3. AO session 状态。
4. 自然语言 report 摘要，仅用于诊断，不直接推进。

处理原则：

- 有合法 decision artifact 时，以 artifact 为准。
- review/manual_gate 的 decision artifact 必须通过 artifact contract registry 定位契约，并通过 outcome 阶段的 `hasCanonicalReviewerSourceProof` 校验；该校验只接受归一化后的 `source="ao_review"`、匹配的 `aoSessionId` 和 reviewer 来源证明。没有 canonical reviewer 来源证明时，返回 `invalid`，不能按 `approved` 或 `rework_required` 推进。
- 来源证明 helper 分两层：`hasAoReviewSourceProof` 用于归集阶段，允许识别归集前的 `control_plane_manual_gate` 等来源证明；`hasCanonicalReviewerSourceProof` 用于 outcome 解析阶段，只接受归集归一化后的 `ao_review` 来源。两个 helper 共享底层字段读取逻辑，但不能混用。
- `manualGateMode === "manual_approve"` 时不消费 AO decision artifact；该模式只接受控制面合成的 `control_plane_manual_gate` 产物和既有 `manualGateReleases.decision === "approved"`。
- `manualGateMode === "ao_review"` 时必须消费 `source="ao_review"` 的结构化 decision artifact。
- `completed` 不自动等于通过，必须通过 `validateTaskOutputArtifacts` 校验所有 required output；`approved` 必须先通过 outcome 解析验证 `decision=approved` 的业务语义，再通过产物层校验。
- `needs_input` 不自动等于失败，必须先检查是否存在 `decision=rework_required`、`decision=blocked`、rework request 或缺结构化决策。
- `stuck`、`failed` 仍可阻断，但如果存在合法结构化产物，应优先消费产物。
- `targetTaskIds` 和 `findings[].targetTaskId` 必须在 `plan.tasks` 中存在，且必须是当前 gate task 的上游任务；目标任务如果已经是 `superseded`，返回 `invalid` 并要求走重规划，不能把 `superseded` 回退为 `pending`。

### 5.2 `src/workflow/manual-gate-outcome.ts`

可选拆分模块，专门处理 manual_gate 三态：

```ts
export async function readManualGateDecision(input: {
  task: ExecutionTask;
  artifactDir: string;
  aoSessionId?: string;
  mode?: "manual_approve" | "ao_review";
}): Promise<ManualGateDecisionReadResult>;
```

职责：

- 找到 decision artifact。
- 校验 `workflowId`、`taskId`、`source`、`aoSessionId`。
- 校验 `approved` 时 flag 是否存在。
- 校验 `rework_required` 时 findings 和 targetTaskIds 是否存在。
- 校验 `blocked` 时 rationale 是否存在。

## 6. 状态机改造

### 6.1 状态策略和 failure kind

本方案不新增顶层 `paused_for_rework`。返工暂停继续复用现有 `paused_for_replan` 状态，但必须通过 `failure.kind`、`taskState.failureReason`、日志事件和 UI 文案区分“计划重规划”和“上游返工”：

- `manual_gate_requires_replan`：计划本身需要改，进入既有重规划流程。
- `manual_gate_rework_required`：当前任务计划仍有效，只是上游任务需要返工，页面展示为“暂停等待返工”。

这样可以复用现有 `restoreFromDisk`、`createOrResume`、`run`、`tick`、轮询和 Web 恢复框架，避免引入新顶层状态造成状态机爆炸。实现时仍要补齐这些入口对新 failure kind 的文案和按钮判断。

新增 failure kind：

```ts
type ExecutionErrorKind =
  | "manual_gate_rework_required"
  | "ao_task_needs_structured_decision"
  | existing kinds;
```

这两个枚举必须同步加入 `ExecutionErrorKind` 类型、zod schema、`taskState.failureReason` 写入逻辑和 UI 文案映射。`ao_task_needs_input` 保留作为 fallback，只用于非 manual_gate/review 且没有结构化产物可消费的场景。

### 6.2 outcome 到状态映射

| Outcome | 调度器行为 |
| --- | --- |
| `approved` | 当前 manual_gate 完成，继续下游 |
| `completed` | 校验 required output，通过后完成 |
| `rework_required` | 进入 `paused_for_replan + failure.kind=manual_gate_rework_required`，记录目标任务和 findings，页面展示为“暂停等待返工” |
| `blocked` | 进入 `failed` 或 `blocked_for_human`，`failure.kind=manual_gate_blocked`，页面展示原因 |
| `needs_structured_decision` | 进入 `blocked_for_human` 或 `failed`，`failure.kind=ao_task_needs_structured_decision`，提示 AO 未写结构化决策 |
| `needs_human` | 进入 `failed`，`failure.kind=ao_task_needs_input`，中断给人工处理 |
| `invalid` | 失败，展示合约错误 |

### 6.3 `needs_input` 新规则

当 AO session status 为 `needs_input`，必须在进入现有 `failureConfirmationCount` 确认窗口之前解析 outcome：

1. 如果存在合法 decision artifact：
   - `approved`：按 approved 处理。
   - `rework_required`：进入返工。
   - `blocked`：阻断。
2. 如果缺 decision artifact，但任务是 manual_gate/review：
   - outcome 为 `needs_structured_decision`。
   - 页面提示“AO 已请求输入，但没有写 required decision/rework artifact”。
3. 如果任务是 implementation/design/verification：
   - 检查是否存在 blocker/rework artifact。
   - 没有则 outcome 为 `needs_human`。

`needs_input` 不再进入 `applyAoStatusObservation` 的失败确认通道。`statusObservations` 与 `failureConfirmationCount` 继续保留，但只用于 `stuck`、`failed` 等没有结构化产物语义可消费的状态。

## 7. 调度流程改造

当前 `syncWorkingTasksWithAo` 中大致流程是：

1. 找 working task。
2. 查 AO session。
3. 如果 session status 是 terminal success，则校验产物并完成。
4. 如果 session status 是 terminal failure，则失败。

改造后：

1. 找 working task。
2. 查 AO session，拿到 `status`、`sessionId`、`worktreePath`、report 摘要。
3. 对当前 task 执行产物归集，把 AO worktree 中合法的控制面产物归集到 canonical `artifactDir`。这里复用 `reconcileTaskOutputsFromAoWorktree` 的候选发现、归属校验和归一化能力；归集失败如果属于路径逃逸、跨项目 worktree、归属字段冲突、候选冲突，则直接阻断。
4. 调用 `resolveAoTaskOutcome`，从 canonical `artifactDir`、artifact contract registry、AO session status 和 report 摘要解析业务 outcome。归集未完成、decision 归一化失败或 canonical decision 来源证明不合法时，outcome 必须返回 `invalid`，不能绕过归集直接消费原始 worktree 文件。
5. 根据 outcome 分发：
   - `approved/completed`：再进入现有 required output 校验，确认所有必需产物存在且合法后完成任务。outcome 层负责业务语义校验，例如 decision 值、findings、targetTaskIds；`validateTaskOutputArtifacts` 负责技术语义校验，例如 source、aoSessionId、required output 存在性、`requiredWhen` 条件产物。
   - `rework_required`：写入 `paused_for_replan + failure.kind=manual_gate_rework_required`。
   - `needs_structured_decision`：写入结构化决策缺失状态。
   - `blocked/needs_human/invalid`：写入阻断状态。
6. 所有 outcome 都写入 execution log。

伪代码：

```ts
for (const taskState of workingTasks) {
  const session = await readAoSession(taskState.aoSessionId);
  const manualGateMode = findManualGateMode(state, taskState.taskId);

  await reconcileTaskOutputsFromAoWorktree({
    task,
    plan,
    state,
    artifactDir,
    projectRoot,
    aoSessionId: taskState.aoSessionId,
    worktreePath: taskState.worktreePath ?? session?.worktreePath,
    manualGateMode
  });

  const outcome = await resolveAoTaskOutcome({
    plan,
    task,
    taskState,
    state,
    session,
    artifactDir,
    manualGateMode
  });

  switch (outcome.kind) {
    case "approved":
    case "completed":
      await validateRequiredOutputsAndComplete(task);
      break;
    case "rework_required":
      await pauseForManualGateRework(task, outcome);
      break;
    case "needs_structured_decision":
      await blockForStructuredDecision(task, outcome);
      break;
    default:
      await applyNonRecoverableOutcome(task, outcome);
  }
}
```

`applyAoStatusObservation` 只能作为 fallback，用于 `stuck`、`failed` 等无结构化产物可解析的 AO 状态；`needs_input` 必须先走 outcome 通道。

新增日志类型：

```ts
type ExecutionLogType =
  | "ao_task_outcome_resolved"
  | "manual_gate_rework_required"
  | "ao_task_needs_structured_decision"
  | "manual_gate_decision_invalid"
  | existing log types;
```

示例日志：

```json
{
  "type": "ao_task_outcome_resolved",
  "taskId": "TASK-009",
  "attempt": 2,
  "actor": "runner",
  "aoSessionId": "ft-11",
  "outcome": {
    "kind": "needs_structured_decision",
    "requiredOutputs": [
      "transport_contract_review_gate_decision.json"
    ]
  }
}
```

日志 payload 约束：

```ts
const aoTaskOutcomeResolvedLogSchema = baseExecutionLogSchema.extend({
  type: z.literal("ao_task_outcome_resolved"),
  taskId: z.string(),
  attempt: z.number().int().nonnegative(),
  aoSessionId: z.string().optional(),
  outcome: z.record(z.unknown())
});

const manualGateReworkRequiredLogSchema = baseExecutionLogSchema.extend({
  type: z.literal("manual_gate_rework_required"),
  taskId: z.string(),
  targetTaskIds: z.array(z.string()),
  findings: z.array(z.record(z.unknown())).default([])
});

const aoTaskNeedsStructuredDecisionLogSchema = baseExecutionLogSchema.extend({
  type: z.literal("ao_task_needs_structured_decision"),
  taskId: z.string(),
  requiredOutputs: z.array(z.string()),
  aoSessionId: z.string().optional()
});

const manualGateDecisionInvalidLogSchema = baseExecutionLogSchema.extend({
  type: z.literal("manual_gate_decision_invalid"),
  taskId: z.string(),
  decisionPath: z.string().optional(),
  reason: z.string()
});
```

## 8. 返工恢复设计

### 8.1 第一阶段行为

当进入 `paused_for_replan + failure.kind=manual_gate_rework_required`：

- 不自动派发下游。
- 页面显示返工目标和 findings。
- 用户可以选择：
  - 派发上游返工。
  - 提交重规划。
  - 标记阻断。
  - 人工补写／确认门禁决策。

该状态由独立工具函数写入，不复用 `decideManualGate("requires_replan")` 的入口语义：

```ts
export async function pauseForManualGateRework(input: {
  store: ExecutionStateStore;
  workflowId: string;
  taskId: string;
  targetTaskIds: string[];
  findings: AoOutcomeFinding[];
  rationale: string;
  actor?: "user" | "cli" | "runner";
}): Promise<ExecutionState>;
```

`pauseForManualGateRework` 与 `decideManualGate("requires_replan")` 必须在 `continuous-plan-execution.ts` 内部共用 `setPausedForReplan(state, failureKind, taskId, message)` 私有 helper，确保两者写出的 `status="paused_for_replan"`、`currentTaskId`、`failure`、日志和 `taskState.failureReason` 结构一致；区别只在 failure kind 和 UI 恢复入口。

`setPausedForReplan` helper 建议签名：

```ts
function setPausedForReplan(input: {
  state: ExecutionState;
  taskId: string;
  failureKind: "manual_gate_requires_replan" | "manual_gate_rework_required";
  message: string;
  manualGateRelease?: ManualGateRelease;
  occurredAt?: string;
}): ExecutionState;
```

该 helper 的副作用必须限定为：

1. 写入 `state.status = "paused_for_replan"`。
2. 写入 `state.currentTaskId = taskId`。
3. 写入 `state.failure = { taskId, kind: failureKind, message, occurredAt }`。
4. 写入 `state.taskStates[taskId].failureReason = failureKind`，但不直接改变该 task 的 runtime status；runtime status 由调用方按场景单独处理。
5. 当 `manualGateRelease` 提供时，追加或替换 `state.manualGateReleases` 中同一 task 的记录；未提供时不修改 `manualGateReleases`。

`decideManualGate("requires_replan")` 调用该 helper 时传入 `manualGateRelease`；`pauseForManualGateRework` 调用该 helper 时不传 `manualGateRelease`，避免把 AO reviewer 的返工结论误写成人工门禁决策。

### 8.2 派发上游返工

新增恢复动作：

```ts
dispatchReworkTask(input: {
  workflowId: string;
  gateTaskId: string;
  targetTaskId: string;
  rationale: string;
})
```

行为：

1. 校验 `targetTaskId` 是当前 gate 的上游任务。
2. 校验 `targetTaskId` 当前状态不是 `superseded`。`superseded` 不可逆，如果目标任务已经 superseded，必须返回 400 并要求走重规划。
3. 获取 execution lock，并通过 `ExecutionStateStore.update()` 进行原子状态迁移，避免 Web 与 CLI 并发修改。
4. 将 target task 状态重置为 pending。
5. 将当前 gate task 重置为 pending，清空 gate 的旧 failureReason。
6. 如果当前 gate task 有旧 `aoSessionId`，把它写入 `state.supersededSessions`，避免 runner 继续轮询旧 reviewer session。
7. 清理 target task 影响的下游状态：
   - 当前 gate task。
   - 依赖该 gate 的未执行任务。
8. 派发 target task。
9. target task 完成后，重新派发 gate task。

如果 targetTaskId 不明确或不在计划中，则要求重规划。

### 8.3 受影响任务判定

新增 DAG 影响范围计算：

```ts
function collectDownstreamTaskIds(plan: TaskPlan, taskId: string): string[];
```

返工时只重置：

- target task。
- 当前 gate task。
- target 下游中尚未完成或由当前 gate 控制的任务。

已经完成且不依赖返工产物的任务不回滚。

边界规则：

1. target task 当前状态是 `pending`、`working`、`blocked_for_human`、`failed`、`completed` 时，可按影响范围重置。
2. target task 当前状态是 `superseded` 时，禁止返工派发，必须走重规划。
3. 受影响任务判定第一版只使用 `dependencies` DAG，不新增“产物依赖”概念，避免扩张任务计划 schema。
4. 下游 `superseded` 任务不复活，继续保持 `superseded`。
5. 当前 gate task 不标记为 `superseded`，而是回到 `pending` 等待上游返工完成后重新复核。

## 9. Prompt 改造

在 `buildAoDispatchContext` 中，对 review/manual_gate 任务增加强制规则：

```text
If this is a review/manual_gate task:
1. You must write the decision artifact listed in expectedOutputs.
2. decision must be one of approved, rework_required, blocked.
3. Do not report needs-input as the final result without writing a decision artifact.
4. If upstream work must change, write decision=rework_required and include targetTaskIds and findings.
5. If approved, write the approved flag required by expectedOutputs.
6. If blocked for external human input, write decision=blocked with rationale.
```

中文说明：

```text
如果发现 B1-B4 这类阻断项，不要只在 ao report 中写自然语言建议。
必须写入 expectedOutputs 中的 decision JSON。
如果需要上游返工，decision=rework_required，并写明 targetTaskIds、findings、requiredAction。
```

## 10. UI 改造

AO 执行页新增“AO 结论”或“门禁结论”区域：

显示字段：

- 当前 AO session。
- AO status。
- 解析后的 outcome。
- required decision artifact。
- approved flag。
- rework request。
- findings。
- targetTaskIds。
- 缺失结构化产物。

按钮行为：

| 状态 | 可用按钮 |
| --- | --- |
| `ao_task_needs_structured_decision` | 补录门禁结论、重新归集产物、要求重规划、标记阻断；不允许直接重试，避免 AO 继续重复缺失结构化决策 |
| `manual_gate_rework_required` | 派发上游返工、要求重规划、标记阻断 |
| `blocked` | 重试任务、标记阻断、重规划 |
| `artifact_output_missing` | 产物归集、重试任务、人工确认完成 |

页面文案示例：

```text
AO 已上报 needs_input，但未写结构化门禁决策。
调度器不能仅凭自然语言“建议 ft-9 修复 B1-B4”推进。
请让 AO 写入 transport_contract_review_gate_decision.json，或使用“人工录入门禁决策”。
```

UI 实现必须与 `docs/long-running-governance-job-ux.md` 的长时治理任务原则保持一致：

1. outcome 诊断区默认作为执行详情的一部分展示关键摘要，详细 artifact/reconcile 诊断可折叠，避免长日志挤占主要操作区。
2. 页面轮询不应在 `paused_for_replan + manual_gate_rework_required`、`ao_task_needs_structured_decision` 等人工处理状态下持续高频刷新。
3. `ui.ts` 的 HTML 字符串测试必须覆盖按钮文案、诊断区标题、缺失结构化决策提示和返工 findings 展示。

`ao_task_needs_structured_decision` 状态下，UI 的 `canRetryExecutionTask` 必须显式返回不可重试，服务端 `retryExecutionTask` 也必须拒绝该 failure kind，防止用户绕过 UI 调 API 触发无效重试。禁用原因是重试只会让 runner 重新派发复核任务，而 AO 已经证明没有按契约写结构化 decision artifact，直接重试大概率重复失败；正确恢复动作是补录门禁结论或重新归集合法 decision artifact。

## 11. API 改造

本方案不新增独立 `/outcome`、`/decision-artifact`、`/rework-dispatch` 路由，避免与现有 execution job API 重叠。所有能力收敛到现有入口。

### 11.1 获取 outcome

扩展现有接口：

```http
GET /api/ao/execution-jobs/:jobId?projectRoot=...
```

在 snapshot 中新增 `aoOutcome` 字段：

```json
{
  "status": "paused_for_replan",
  "currentTaskId": "TASK-009",
  "failure": {
    "kind": "manual_gate_rework_required",
    "message": "AO review requires upstream rework"
  },
  "aoOutcome": {
    "kind": "rework_required",
    "failureKind": "manual_gate_rework_required",
    "taskId": "TASK-009",
    "aoSessionId": "ft-11",
    "targetTaskIds": ["TASK-008"],
    "findings": []
  }
}
```

### 11.2 人工录入门禁决策

复用现有 manual gate decision 入口：

```http
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/decision?projectRoot=...
```

现有 `approved`、`requires_replan`、`blocked` 语义保持不变。页面补录门禁结论时不让用户手写 JSON，而是提交结构化表单，由服务端生成规范 decision artifact。若需要区分“人工补录 AO 复核结论”和“人工直接放行”，在 body 中增加 `mode` 或 `source` 字段，不新增路由。

### 11.3 派发返工

复用现有 revision request 入口：

```http
POST /api/ao/execution-jobs/:jobId/revision-requests?projectRoot=...
```

新增 `reasonCategory = "manual_gate_rework"`，与既有 `manual_gate_dispute` 区分：

```json
{
  "triggerTaskId": "TASK-009",
  "reasonCategory": "manual_gate_rework",
  "rationale": "按 B1-B4 派发 TASK-008 上游返工",
  "targetTaskIds": ["TASK-008"]
}
```

服务端根据 `reasonCategory` 进入返工暂停恢复路径，而不是创建计划修订草稿。所有路由必须继续支持 `projectRoot`，并通过 `getExecutionManager(projectRoot)` 获取正确项目的 manager。

服务端分流规则：

1. `server.ts` 在 `POST /api/ao/execution-jobs/:jobId/revision-requests` 入口读取 body 后，必须在 `PlanRevisionRequest` zod 校验之前先判断 `reasonCategory === "manual_gate_rework"`。
2. 命中 `manual_gate_rework` 时，不调用 `manager.requestRevision`，改为调用 `manager.dispatchReworkTask({ jobId, gateTaskId: triggerTaskId, targetTaskId, rationale })`。
3. `ExecutionJobManager.dispatchReworkTask` 内部调用 `pauseForManualGateRework` 和返工派发状态迁移，且必须获取 execution lock。
4. `PlanRevisionRequest` schema 不需要新增 `manual_gate_rework` 枚举，因为该分支已经在路由入口的 zod 校验之前被消费；这样可以保证 `manual_gate_rework` 不进入 Codex 任务计划修订流程，也不会生成 `task-plan-amendment-*.json`。
5. 其他 `reasonCategory` 保持原 `manager.requestRevision` 和计划修订流程不变。

入口分流伪代码：

```ts
if (body.reasonCategory === "manual_gate_rework") {
  return sendJson(
    input.response,
    200,
    await manager.dispatchReworkTask(jobId, {
      gateTaskId: body.triggerTaskId,
      targetTaskId: body.targetTaskIds?.[0],
      rationale: body.rationale ?? ""
    })
  );
}

return sendJson(input.response, 200, await manager.requestRevision(jobId, body));
```

## 12. 数据兼容与迁移

已有 workflow 可能已经处于：

- `failed + ao_task_needs_input`
- `failed + ao_task_stuck`
- `blocked_for_human + needs_input`

迁移策略：

1. 不直接改历史状态。
2. 页面加载 snapshot 时调用 outcome resolver。
3. 如果历史失败任务存在合法 decision/rework artifact，则允许“一键恢复为 outcome 状态”。
4. 如果没有结构化产物，则展示 `needs_structured_decision`，引导补写门禁结论或重新归集产物。

## 13. 验收标准

本次改造完成后必须满足：

1. `needs_input + missing decision artifact` 不再被解释成普通失败，页面明确显示“缺结构化决策”。
2. `needs_input + decision=rework_required` 进入 `paused_for_replan + failure.kind=manual_gate_rework_required`，展示 findings 和 targetTaskIds，页面文案为“暂停等待返工”。
3. `completed + decision=rework_required` 不会误判完成。
4. `completed + decision=approved + approved.flag` 才能完成 manual_gate 并继续下游。
5. `completed + missing required output` 仍走 artifact reconcile，不能放行。
6. AO prompt 明确要求 reviewer 写三态 decision artifact。
7. UI 能看到当前需要复核什么、缺什么、谁返工、下一步按钮是什么。
8. 旧 workflow 可通过重新归集、补写结构化决策，或在普通可重试失败场景下重试继续，不需要手改 JSON。

## 14. 测试计划

新增测试：

1. `ao-task-outcome.test.ts`
   - 解析 `approved` decision。
   - 解析 `rework_required` decision。
   - 解析 `blocked` decision。
   - `needs_input` 缺 decision 时返回 `needs_structured_decision`。
   - 自然语言 report 不直接驱动返工。

2. `continuous-plan-execution.test.ts`
   - `needs_input + no artifact` 不直接覆盖为普通失败。
   - `rework_required` 进入 `paused_for_replan + manual_gate_rework_required`。
   - `approved` 后继续下游。
   - `completed + rework_required` 不能完成。

3. `execution-jobs.test.ts`
   - snapshot 返回 outcome。
   - failed 历史状态可附加 outcome 诊断。
   - `reasonCategory=manual_gate_rework` 能重置目标任务并启动 runner。

4. `server.test.ts`
   - snapshot 获取 outcome。
   - 复用 manual gate decision API 补录 decision artifact。
   - 复用 revision request API 派发返工。

5. `ui` 字符串断言
   - 页面包含“缺结构化决策”。
   - 页面包含返工 findings 区块。
   - 页面包含“派发上游返工”按钮。
   - `renderIndexHtml` 生成的 HTML 包含 outcome 诊断区和补录门禁结论按钮。

## 15. 风险与边界

1. AO 不写结构化产物时，调度器不能安全自动推进。这是正确阻断，不应继续猜。
2. 自动返工可能影响已完成下游任务，必须通过 DAG 影响范围计算控制。
3. 自然语言 report 可以展示，但不能成为唯一事实来源。
4. 返工目标不明确时必须重规划或人工决策。
5. 若 AO status 与结构化 artifact 冲突，以 artifact contract 校验为准；冲突本身要记录为诊断。

## 16. 推荐落地顺序

1. 扩展 `ExecutionErrorKind` 与 `executionLogTypeSchema`，加入 `manual_gate_rework_required`、`ao_task_needs_structured_decision` 和对应日志事件。
2. 新增 `setPausedForReplan` 私有 helper 与 `pauseForManualGateRework` 工具函数。
3. 重构 `decideManualGate("requires_replan")`，让它复用 `setPausedForReplan`，并验证原有 `manualGateReleases` 写入语义不变。
4. 新增 `ao-task-outcome.ts` 与必要的 `manual-gate-outcome.ts`，只做 outcome 解析，不先接入 runner。
5. 增加 outcome 单元测试，覆盖 approved、rework_required、blocked、needs_structured_decision、自然语言 report 不直接返工。
6. 修改 `syncWorkingTasksWithAo`，在 `applyAoStatusObservation` 前插入 outcome 解析层，让 `needs_input` 不再进入 `failureConfirmationCount` 通道，并同步处理 `supersededSessions`、`pendingDispatch` 和 `superseded` 不可逆校验。
7. 增强 `buildAoDispatchContext` prompt，加入 review/manual_gate 三态 decision artifact 硬规则。
8. 扩展 `getSnapshot` 返回 `aoOutcome` 字段，不新增 `/outcome` 路由。
9. 扩展 `/revision-requests` 对 `reasonCategory=manual_gate_rework` 的服务端分流，新增 `ExecutionJobManager.dispatchReworkTask`，且必须在 `PlanRevisionRequest` zod 校验之前分流，不进入 Codex 计划修订流程。
10. 修改 `ui.ts` 在执行详情加入 outcome 诊断区、补录门禁结论入口和派发上游返工入口。
11. 跑全量测试并用 `WF-20260630T031508Z / TASK-009 / ft-11` 场景做回归验证。

## 17. 与现有项目设计的对齐补充

本方案不是替换现有连续执行设计，而是在现有执行期链路上补一层 AO 结果语义解析。落地时必须遵守以下对齐原则。

### 17.1 继承的既有设计

本方案必须继续复用以下已落地或已设计的能力：

1. `continuous-task-scheduler-design.md` 定义的连续执行状态机、执行日志、重试、人工标记完成、重规划、`manual_gate` 暂停和 Web API 基础模型。
2. `continuous-task-scheduler-context-bridge-design.md` 定义的 AO 派发上下文包、`artifactDir` 权威证据目录、`dispatch-context` manifest，以及“门禁放行”和“派发 AO 复核”两个动作拆分。
3. `continuous-task-scheduler-artifact-reconcile-and-worktree-cleanup-design.md` 定义的 AO worktree 产物归集、归集日志和 worktree 生命周期边界。
4. `continuous-task-scheduler-artifact-contract-registry-design.md` 定义的 artifact contract registry、canonical file、`contractId`、`requiredWhen`、`sessionField`、候选路径优先级和路径归属校验。
5. `task-plan-model-output-normalization-plan.md` 定义的任务计划归一化、`inputArtifacts/outputArtifacts` 固化和 reviewer/manual_gate 任务角色归一化。

因此，`AoTaskOutcome` 只能消费这些已有结构，不允许重新发明一套文件名推断、产物路径推断或 manual_gate 规则。

### 17.2 当前代码对接点

落地时的主要代码对接点如下：

| 文件 | 当前职责 | 本方案改造方式 |
| --- | --- | --- |
| `src/workflow/continuous-plan-execution.ts` | runner tick、AO session 同步、任务完成／失败映射、重试、人工完成、manual_gate 决策 | 在 `syncWorkingTasksWithAo` 中接入 outcome resolver，替换直接用 `terminalFailureStatusKinds.needs_input -> ao_task_needs_input` 的判定 |
| `src/workflow/execution-state-store.ts` | `ExecutionJobStatus`、`ExecutionErrorKind`、日志类型和状态持久化 | 不新增顶层 job status；增加 `manual_gate_rework_required`、`ao_task_needs_structured_decision` 等错误／日志 schema，并同步写 `taskState.failureReason` |
| `src/workflow/ao-dispatch-context.ts` | 构造 AO prompt、manifest、manual gate artifact 合成、requiredWhen 校验 | 增强 review/manual_gate prompt 硬规则；复用 registry 输出 `artifactContracts`；不得手写新的契约映射 |
| `src/workflow/artifact-contract-registry.ts` | 产物契约注册表、manual_gate decision/flag/rework 契约 | outcome resolver 读取 decision/rework/flag 时必须优先通过 registry 定位契约 |
| `src/workflow/ao-output-reconcile.ts` | 从 AO worktree 归集产物到 `artifactDir` | outcome 解析前必须先调用归集，避免 AO 已写产物但 canonical 缺失时误判 |
| `src/web/execution-jobs.ts` | execution snapshot、恢复动作、manual_gate API、artifact diagnostics | snapshot 增加 outcome 诊断；复用现有恢复入口并补充返工派发能力 |
| `src/web/server.ts` | Web API 路由 | 优先扩展现有 execution job 路由；所有扩展能力必须带 `projectRoot` 兼容现有多项目 manager |
| `src/web/ui.ts` | 页面展示和按钮状态 | 在现有执行详情里增加“AO 结论／结构化产物／返工目标”区域，按钮复用现有恢复动作语义 |

### 17.3 artifact contract registry 是唯一产物事实来源

`AoTaskOutcome` 解析 review/manual_gate 产物时必须按以下顺序定位产物：

1. 从当前任务的 `outputArtifacts` 读取 `contractId`。
2. 用 `getArtifactContractRegistry().findById(contractId)` 获取 canonical file、`requiredWhen`、`sessionField` 和候选路径规则。
3. 如果旧计划没有 `contractId`，允许用 `kind + path` 兼容，但必须反查 registry；反查失败时返回 `artifact_contract_missing` 或 `needs_structured_decision`，不能继续猜文件名。
4. `decision`、`approved flag`、`rework request` 的存在性和条件性必须由 registry 与 `evaluateRequiredWhen` 共同决定。

这条规则用于避免再次出现 `transport_contract_freeze.json`、`transport_contract_review_gate_decision.json` 等路径与期望产物不一致的问题。

### 17.4 outcome 解析前必须先归集

当前系统已经支持从 AO worktree 归集产物。为避免“AO 实际写了产物，但调度器只看 canonical 目录导致失败”，`syncWorkingTasksWithAo` 的顺序必须调整为：

1. 读取 AO session snapshot，包括 `status`、`sessionId`、`worktreePath`、report 摘要。
2. 对当前 working task 调用 `reconcileTaskOutputsFromAoWorktree`，传入 `workflowId`、`taskId`、`aoSessionId`、`artifactDir`、`projectRoot`、`worktreePath` 和任务契约。
3. 将归集结果写入 execution log，包括 recovered、missing、conflict、ambiguous、contract violation、worktree resolution。
4. 再调用 `resolveAoTaskOutcome` 读取 canonical artifactDir 中的结构化产物。
5. 最后根据 outcome 做状态迁移。

只有当归集返回不可恢复的路径逃逸、跨项目 worktree、归属字段冲突、候选冲突时，才可以在 outcome 前阻断。

### 17.5 manual_gate 两种模式的边界

现有设计已经把 manual_gate 拆成两个动作，本方案必须保持这个边界。

| 模式 | 触发方式 | 产物 source | 调度器行为 |
| --- | --- | --- | --- |
| `manual_approve` | 用户在页面点击“门禁放行” | `control_plane_manual_gate` | 控制面直接生成 decision/flag，把 gate task 标记为 completed，继续后续任务 |
| `ao_review` | 用户点击“派发 AO 复核”或调度器按 release 记录派发 reviewer | `ao_review` | AO 必须写 decision JSON；调度器解析 `approved/rework_required/blocked` 后推进 |

`manualGateReleases` 的既有 decision 含义保持不变：

| `manualGateReleases.decision` | 含义 | 与 outcome 的关系 |
| --- | --- | --- |
| `approved` | 人工已放行 | 等价于 `manual_approve + approved`，不再派发 AO reviewer |
| `review_dispatched` | 已派发 AO 复核 | 等待 AO 写 `ao_review` decision artifact |
| `requires_replan` | 人工认为计划要改 | 进入 `paused_for_replan`，不属于 AO outcome |
| `blocked` | 人工明确阻断 | 进入 failed/block，不属于 AO 自动返工 |

AO reviewer 的 `decision=rework_required` 不能写入 `manualGateReleases.decision`，它属于新的 `AoTaskOutcome.kind = "rework_required"`，并进入返工恢复路径。

### 17.6 状态机与恢复入口覆盖清单

本方案不新增 `paused_for_rework`，但 `manual_gate_rework_required` 仍然会影响现有 `paused_for_replan` 的多个调用点。必须同步覆盖以下位置：

1. `ExecutionErrorKind` 类型和 zod schema 新增 `manual_gate_rework_required`、`ao_task_needs_structured_decision`。
2. `executionLogTypeSchema` 新增 `ao_task_outcome_resolved`、`manual_gate_rework_required`、`ao_task_needs_structured_decision`、`manual_gate_decision_invalid`。
3. `taskState.failureReason` 同步写入 outcome 对应 failure kind，方便 UI 和恢复动作判断。
4. `restoreFromDisk` 识别 `paused_for_replan + manual_gate_rework_required`，并恢复为可查询 job。
5. `createOrResume` 对 `paused_for_replan + manual_gate_rework_required` 返回“等待上游返工处理”的 409 文案，而不是普通重规划文案。
6. `run()` 和 `tick()` 对 `paused_for_replan` 的早返回保持不变，但 UI 和 snapshot 必须通过 failure kind 区分返工与重规划。
7. `resume`、`stop`、`retryExecutionTask`、`markExecutionTaskCompleted`、`requestRevision` 的允许状态必须补充 `manual_gate_rework_required` 分支。
8. UI 的按钮启用条件、状态说明、执行详情文案必须按 failure kind 分支展示。
9. 所有新状态迁移必须通过 `ExecutionStateStore.update()`，失败写入应复用 `failCurrentState`；返工暂停必须使用 `pauseForManualGateRework`。`pauseForManualGateRework` 与 `decideManualGate("requires_replan")` 不共用入口，但内部共用 `setPausedForReplan` helper，保持 `paused_for_replan` 状态写入结构一致。

### 17.7 API 以复用现有入口为主

本方案的 API 设计必须和现有接口合并，避免页面出现两套相似按钮。

| 能力 | 推荐处理 |
| --- | --- |
| 获取 outcome | 放入现有 `GET /api/ao/execution-jobs/:jobId` snapshot，不新增 `/outcome` 路由 |
| 人工录入门禁决策 | 扩展现有 manual_gate decision API，由表单生成 artifact，不要求用户手写 JSON，不新增 `/decision-artifact` 路由 |
| 派发 AO 复核 | 复用现有 manual_gate `review_dispatched` 语义 |
| 要求重规划 | 复用现有 request revision / `requires_replan` |
| 重试当前任务 | 复用现有 retry，但 `ao_task_needs_structured_decision` 不允许直接 retry，必须先补录 decision 或重新归集到合法产物 |
| 派发上游返工 | 复用现有 `/revision-requests`，新增 `reasonCategory=manual_gate_rework` 分支，并在 `server.ts` 路由入口、`PlanRevisionRequest` zod 校验之前分流；必须复用 execution manager、store update、日志和 projectRoot 解析；不允许进入 Codex 计划修订流程 |
| 产物重新归集 | 复用现有 artifact diagnostics / reconcile 入口 |

所有接口都必须继续支持 `projectRoot`，否则多项目 execution manager 下会再次出现 `execution job not found`。

### 17.8 UI 文案与按钮合并

页面不应再出现语义重复的按钮。推荐按钮文案如下：

| 场景 | 主按钮 | 辅助按钮 |
| --- | --- | --- |
| `waiting_manual_gate` 且未派发复核 | “人工放行” | “派发 AO 复核”、“要求重规划”、“标记阻断” |
| `ao_task_needs_structured_decision` | “补录门禁结论” | “重新归集产物”、“要求重规划”、“标记阻断” |
| `manual_gate_rework_required` | “派发上游返工” | “要求重规划”、“标记阻断” |
| `artifact_output_missing` | “重新归集产物” | “重试任务”、“人工标记完成”、“要求重规划” |
| 普通 AO 失败 | “重试任务” | “人工标记完成”、“要求重规划”、“标记阻断” |

“重试任务”和“重新执行复核任务”不再作为两个独立按钮出现。页面只保留一个“重试任务”入口，根据当前 `failure.kind` 展示不同 tooltip；当 `failure.kind === "ao_task_needs_structured_decision"` 时禁用重试，提示必须先补录门禁结论或归集合法 decision artifact。

页面必须直接展示：

1. 当前 AO session。
2. AO 原始状态。
3. 解析后的 outcome。
4. 缺失的 canonical artifact。
5. 已归集或未归集的 worktree 候选。
6. 如果是返工，展示 `targetTaskIds`、findings、requiredAction。
7. 如果是结构化决策缺失，展示应写入的 decision/rework/flag 文件路径。

### 17.9 旧 workflow 的恢复策略

对已经失败的历史 workflow，不能要求用户手动改 `execution-state.json`。恢复策略如下：

1. 页面加载 snapshot 时，如果当前状态是 `failed + ao_task_needs_input`、`failed + ao_task_stuck`、`artifact_output_missing`，自动运行只读 outcome diagnostics。
2. 如果 diagnostics 发现 AO worktree 有合法产物，提示“可重新归集产物并继续”。
3. 如果 canonical 已有合法 `decision=approved`，允许恢复为 completed 并继续。
4. 如果 canonical 已有合法 `decision=rework_required`，允许恢复为 `paused_for_replan + failure.kind=manual_gate_rework_required`。
5. 如果没有结构化产物，展示 `needs_structured_decision`，用户可以选择重新归集产物或通过页面补录门禁结论；不允许直接重试 AO 复核。
6. 所有恢复动作必须写 execution log，不静默修改历史状态。

### 17.10 并发、锁和可观测性

返工派发、人工补录 decision、历史 workflow 恢复都属于会修改 execution state 的恢复动作，必须遵守现有并发边界：

1. Web/API 入口必须获取 `execution-lock.ts` 提供的 `ExecutionLockHandle`，避免 Web、CLI 或 runner 同时修改同一个 workflow。
2. 返工派发时如果存在旧 `pendingDispatch`，必须先把旧 gate session 标记到 `supersededSessions`，再清理或覆盖 pending dispatch，避免旧 session 与新返工任务同时推进。
3. 所有状态写入必须通过 `ExecutionStateStore.update()` 队列；如果需要写入普通 failure，应复用 `failCurrentState`；如果是返工暂停，必须使用 `pauseForManualGateRework`，并在内部复用 `setPausedForReplan` helper，避免把返工错误写成普通失败或复制 `decideManualGate` 的状态写入逻辑。
4. outcome resolver 只做解析和诊断，不直接写状态；状态迁移统一留给 runner 或 execution manager。
5. 运行日志必须统计以下事件，作为最小可观测性：`ao_task_outcome_resolved` 次数、`manual_gate_rework_required` 次数、`ao_task_needs_structured_decision` 次数、返工派发成功／失败次数、人工补录 decision 次数。
6. 这些指标第一版不新增外部 metrics 系统，先写入 `execution-log.jsonl` 和 snapshot summary，后续如需接入监控再从日志聚合。

## 18. 调整后的最终落地清单

本次开发必须一次性完成以下交付项：

1. 新增 `src/workflow/ao-task-outcome.ts`，实现基于 registry、reconcile 后 canonical artifact、AO status 和 report 摘要的 outcome resolver。
2. 必要时新增 `src/workflow/manual-gate-outcome.ts`，但其产物定位必须调用 artifact contract registry。
3. 修改 `continuous-plan-execution.ts`，新增 `setPausedForReplan` 私有 helper 与 `pauseForManualGateRework` 工具函数；这是工具函数层交付。
4. 修改 `continuous-plan-execution.ts`，让 `decideManualGate("requires_replan")` 复用 `setPausedForReplan`，并保持原有 `manualGateReleases` 写入语义；这是既有门禁决策重构交付。
5. 修改 `continuous-plan-execution.ts`，在 AO 状态同步中先归集、再解析 outcome、再迁移状态；这是 runner 接入交付。
6. 修改 `execution-state-store.ts`，增加 `manual_gate_rework_required`、`ao_task_needs_structured_decision` 和相关日志 schema；不新增顶层 `paused_for_rework`。
7. 修改 `ao-dispatch-context.ts`，让 review/manual_gate prompt 明确要求三态 decision artifact，且 manifest 使用 registry 的 `artifactContracts`。
8. 修改 `execution-jobs.ts`，snapshot 返回 outcome 诊断，并实现历史失败 workflow 的 outcome 恢复入口；同步覆盖 `restoreFromDisk`、`createOrResume`、`resume`、`stop` 对 `manual_gate_rework_required` 的文案和恢复判断。
9. 修改 `server.ts`，复用现有 manual gate decision 与 revision request 路由补齐决策补录和返工派发；`reasonCategory=manual_gate_rework` 必须在 `/revision-requests` 路由入口、`PlanRevisionRequest` zod 校验之前分流到 `manager.dispatchReworkTask`，不得进入 Codex 计划修订流程，所有路由支持 `projectRoot`。
10. 补齐返工派发的 execution lock、`pendingDispatch` 清理、`supersededSessions` 写入和 `superseded` 不可逆校验。
11. 修改 `ui.ts`，增加 AO 结论区域、缺失结构化产物展示、返工 findings 展示，并合并重复按钮文案。
12. 增加单元测试、Web/API 测试、UI HTML 字符串测试和 `WF-20260630T031508Z / TASK-009 / ft-11` 类似场景回归。
13. 验证 `pnpm typecheck`、`pnpm lint`、针对性 vitest 和 `pnpm test`。

## 19. 审查建议处理结论

本次审查报告中的建议全部采纳，没有保留不整改项。关键调整包括：

1. 不新增 `paused_for_rework` 顶层状态，改为复用 `paused_for_replan + failure.kind=manual_gate_rework_required`。
2. `needs_input` 在第一次观测时进入 outcome 解析，不再进入 `failureConfirmationCount`。
3. 新增 failure kind、日志事件和 `taskState.failureReason` 写入要求。
4. API 不新增 `/outcome`、`/decision-artifact`、`/rework-dispatch`，统一复用 snapshot、manual gate decision 和 revision request。
5. 明确 `pauseForManualGateRework` 与 `decideManualGate("requires_replan")` 不共用入口，但内部共用 `setPausedForReplan` helper。
6. 明确 `ao_task_needs_structured_decision` 禁用 UI 和服务端 retry，只允许补录门禁结论或重新归集合法 decision artifact。
7. 明确 `reasonCategory=manual_gate_rework` 在 server 入口分流到 `manager.dispatchReworkTask`，不得进入 Codex 计划修订流程。
8. 明确归集阶段使用 `hasAoReviewSourceProof`，outcome 阶段使用 `hasCanonicalReviewerSourceProof`。
9. 明确 outcome 层校验业务语义，`validateTaskOutputArtifacts` 层校验技术语义。
10. 补齐 `restoreFromDisk`、`createOrResume`、`run`、`tick`、`resume`、`stop`、UI 按钮和长时治理 UX 对齐要求。
11. 显式补齐 `setPausedForReplan` helper 签名、副作用和 `manualGateRelease` 处理边界。
12. 明确 `manual_gate_rework` 在 `/revision-requests` 路由入口、`PlanRevisionRequest` zod 校验之前分流，`PlanRevisionRequest` schema 不新增该枚举。
13. 调整 §16 落地顺序与 §18 落地清单粒度，区分工具函数、既有门禁重构和 runner 接入三类交付。
