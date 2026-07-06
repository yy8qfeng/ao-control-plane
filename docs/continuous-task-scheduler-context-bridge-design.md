# 连续任务调度器 AO 上下文桥接与门禁拆分设计方案

## 1. 背景

当前连续任务调度器已经可以按任务顺序、依赖关系、AO session 状态和 AO report 推进任务。但在真实执行 `WF-20260630T031508Z` 时暴露出一个系统性问题：

- `TASK-001` 已经产出控制平面产物 `g0_repo_reality_check.json`。
- `TASK-002` 是 `manual_gate` + reviewer 复核任务，理论上应该审查 `TASK-001` 的产物。
- 用户点击“门禁放行继续”后，调度器将 `TASK-002` 派发给 AO。
- AO 的 `ft-2` worktree 里只有仓库工作副本内容，没有明确收到 `.ao-control-plane/WF-...` 下的产物路径，也不知道应审查哪个控制平面产物。
- AO 因此判断“没有可审计对象、没有 gate 产物”，并上报 waiting。

这个问题不是单个任务的偶发问题，而是“AO worktree”和“控制平面产物目录”之间缺少上下文桥接。后续所有依赖前序产物、审查产物、门禁文件、QA verdict、release verdict 的任务，都可能出现类似问题。

## 2. 目标

本次设计目标是补齐连续任务调度器的上下文桥接和门禁语义：

1. AO 派发时自动补充控制平面上下文，避免 AO 只看到自己的 worktree。
2. 任务计划中的前序产物、验收产物、门禁产物必须有明确路径。
3. `manual_gate` 拆成两个不同动作：
   - “门禁放行”：人工直接批准该门禁，控制平面生成门禁产物并把门禁任务标记完成。
   - “派发门禁复核”：把该门禁任务派给 AO reviewer，由 AO 读取上下文产物并产出复核结论。
4. 页面文案、API、状态机和日志语义保持一致，避免用户误以为“放行”还会派发 AO。
5. 当前工作流可以从 `TASK-002` 的混乱状态中恢复。

## 3. 非目标

本方案不引入额外 agent。

本方案不改变 AO 自身的 worktree 管理方式，也不要求 AO 自动挂载 `.ao-control-plane`。控制平面通过 prompt、manifest 和明确路径把上下文传给 AO。

本方案不要求所有任务都必须依赖控制平面产物。纯源码实现任务仍然可以只基于仓库文件执行。

本方案仅覆盖执行期 `manual_gate`、AO dispatch、AO report 归一化和执行状态恢复，不接管计划期的设计审查、任务计划审查、`task-plan-review-loop.ts` 或 `task-plan-revision-review-loop.ts`。计划期 review-loop 仍然按现有流程产出评审文件；执行期只把这些已落盘产物作为上下文输入引用。

## 4. 问题边界

### 4.1 普通实现任务

普通实现任务通常只需要源码、测试、构建脚本等仓库内文件。AO worktree 本身能看到这些文件，因此风险较低。

例如：

- 修改 Rust 源码。
- 修改 Java API。
- 添加单元测试。
- 更新项目内文档。

这类任务仍需要基础上下文，但不一定依赖 `.ao-control-plane` 产物。

### 4.2 产物依赖任务

以下任务必须显式桥接控制平面产物：

- reviewer 复核任务。
- `manual_gate` 任务。
- 契约冻结任务。
- QA verdict 汇总任务。
- release verdict 任务。
- 依赖上游 JSON、flag、report、schema、evidence 的任务。
- 需要读取 `design.md`、`task-plan.json`、`execution-state.json` 的任务。

如果 prompt 没有明确输入路径，AO 很容易只看自己的 worktree 并误判“没有可审计对象”。

## 5. 核心设计

### 5.1 AO 派发上下文包

调度器在每次调用 `ao spawn` 前生成一个“AO 派发上下文包”，并把它追加到最终 prompt 中。

上下文包不是替代原任务 `aoPrompt`，而是在原 prompt 后追加一个标准区块：

```text

---
AO 控制平面上下文

projectRoot:
C:\workspace\fast-transport

workflowId:
WF-20260630T031508Z

artifactDir:
C:\workspace\fast-transport\.ao-control-plane\WF-20260630T031508Z

核心输入文件：
1. 需求文件：C:\workspace\fast-transport\.ao-control-plane\WF-...\requirement.json
2. 设计稿：C:\workspace\fast-transport\.ao-control-plane\WF-...\design.md
3. 任务计划：C:\workspace\fast-transport\.ao-control-plane\WF-...\task-plan.json
4. 执行状态：C:\workspace\fast-transport\.ao-control-plane\WF-...\execution-state.json
5. 执行日志：C:\workspace\fast-transport\.ao-control-plane\WF-...\execution-log.jsonl

上游依赖任务产物：
1. TASK-001 / G0 仓库现实校准
   - C:\workspace\fast-transport\.ao-control-plane\WF-...\g0_repo_reality_check.json

当前任务预期输出：
1. C:\workspace\fast-transport\.ao-control-plane\WF-...\g0_review_gate_decision.json
2. C:\workspace\fast-transport\.ao-control-plane\WF-...\g0_approved.flag

执行要求：
1. 不要只检查当前 AO worktree。
2. 控制平面 artifactDir 下的文件是本任务的正式输入和输出位置。
3. 若上游产物缺失，应明确报告缺失路径和阻断原因，不得凭空通过。
4. 输出产物必须写入上述 artifactDir，而不是仅写入 AO worktree。
---
```

### 5.2 上下文 manifest 文件

除 prompt 追加文本外，调度器还应为每次派发写入一个机器可读 manifest：

```text
ao-dispatch-context-TASK-002-attempt-1.json
```

建议路径：

```text
{artifactDir}/dispatch-context/ao-dispatch-context-{taskId}-attempt-{attempt}.json
```

示例结构：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "taskId": "TASK-002",
  "attempt": 1,
  "projectRoot": "C:\\workspace\\fast-transport",
  "artifactDir": "C:\\workspace\\fast-transport\\.ao-control-plane\\WF-20260630T031508Z",
  "coreInputs": [
    { "kind": "requirement", "path": "C:\\...\\requirement.json", "required": true },
    { "kind": "design", "path": "C:\\...\\design.md", "required": true },
    { "kind": "task_plan", "path": "C:\\...\\task-plan.json", "required": true },
    { "kind": "execution_state", "path": "C:\\...\\execution-state.json", "required": true },
    { "kind": "execution_log", "path": "C:\\...\\execution-log.jsonl", "required": false }
  ],
  "dependencyArtifacts": [
    {
      "taskId": "TASK-001",
      "title": "G0 仓库现实校准",
      "artifacts": [
        {
          "kind": "g0_repo_reality_check",
          "path": "C:\\...\\g0_repo_reality_check.json",
          "required": true
        }
      ]
    }
  ],
  "expectedOutputs": [
    {
      "kind": "gate_decision",
      "path": "C:\\...\\g0_review_gate_decision.json",
      "requiredOnSuccess": true
    },
    {
      "kind": "approved_flag",
      "path": "C:\\...\\g0_approved.flag",
      "requiredOnSuccess": true
    }
  ],
  "instructions": [
    "Do not rely only on the AO worktree.",
    "Use artifactDir as the control-plane evidence directory.",
    "Write task evidence outputs to artifactDir."
  ]
}
```

AO prompt 中必须包含该 manifest 的绝对路径。这样即使 prompt 内容很长，AO 也能读取机器可读上下文。

`dispatch-context` 子目录专门用于派发上下文快照，避免污染 workflow 根目录下的正式业务产物和状态文件。读取 workflow 状态时只读取明确文件名，例如 `workflow.json`、`task-plan.json`、`execution-state.json`，不得把 `dispatch-context` 下的文件当成 workflow 状态或计划版本扫描。

`ao-dispatch-context.ts` 只读引用计划期 review-loop 产物，例如 `task-plan.json`、`task-plan-review-latest.json`、设计稿和审批报告；它不得修改计划期 review-loop 的状态、轮次或审查结论。计划期文件在执行期只作为证据输入。

## 6. 任务计划产物契约

### 6.1 增加任务级产物字段

当前 `TaskPlan.tasks[]` 主要依靠自然语言 `acceptanceCriteria` 和 `aoPrompt` 描述产物。后续应增加结构化字段：

```json
{
  "inputArtifacts": [
    {
      "taskId": "TASK-001",
      "kind": "g0_repo_reality_check",
      "path": "g0_repo_reality_check.json",
      "required": true
    }
  ],
  "outputArtifacts": [
    {
      "kind": "g0_review_gate_decision",
      "path": "g0_review_gate_decision.json",
      "required": true
    },
    {
      "kind": "g0_approved_flag",
      "path": "g0_approved.flag",
      "requiredWhen": "decision=approved"
    }
  ]
}
```

路径规则：

- 相对路径默认相对于 `artifactDir`。
- 绝对路径允许，但必须位于 `projectRoot` 或 `artifactDir` 下。
- `inputArtifacts` 可引用依赖任务产物。
- `outputArtifacts` 是当前任务必须生成或校验的产物。

`requiredWhen` 使用最小条件语法，避免在第一版引入复杂表达式：

- 支持 `<field>=<value>`，例如 `decision=approved`。
- 支持 `&&` 连接多个相等判断，例如 `decision=approved&&source=ao_review`。
- 暂不支持 `||`、括号、正则、比较运算和脚本表达式。
- 条件字段只能来自已解析的同任务结构化输出产物，例如 `gate_decision` 文件中的 `decision` 字段。
- 如果条件依赖的基础文件缺失或不可解析，直接判定为 `artifact_output_missing`，不继续求值 `requiredWhen`。

### 6.2 兼容旧计划

为兼容现有计划，调度器按以下优先级解析产物：

1. `inputArtifacts` 和 `outputArtifacts` 字段。
2. 内置模板映射。
3. `acceptanceCriteria` 和 `aoPrompt` 中出现的文件名仅作为模板匹配的辅助证据，不单独作为稳定推断依据。

只有命中内置模板的任务才允许走推断路径。未命中模板且缺少结构化 `inputArtifacts/outputArtifacts` 的产物依赖任务，一律视为“上下文产物不完整”，进入 `blocked_for_human` 或阻止派发，由用户选择补结构化字段、提交重规划请求或在明确风险下强制派发普通实现任务。`manual_gate`、reviewer、QA verdict、release verdict 任务不允许无结构化产物或无模板命中时强制派发。

内置模板清单：

| 任务特征 | 输入产物 | 输出产物 |
| --- | --- | --- |
| `G0 仓库现实校准` | `requirement.json`、`design.md`、`task-plan.json` | `g0_repo_reality_check.json` |
| `G0 人工复核放行` | `g0_repo_reality_check.json` | `g0_review_gate_decision.json`、`g0_approved.flag` |
| `G0 复核失败回流重规划` | `g0_review_gate_decision.json` | `g0_replan_request.json` |
| `planning gate` 或任务计划本地门禁 | `task-plan.json`、`task-plan-review-latest.json` | `task-plan-approval-report.json` |
| `contract freeze` 或契约冻结 | 上游 gate decision、设计稿、任务计划 | 对应契约冻结 JSON 或 Markdown 证据文件 |
| `QA verdict` | 各平台测试报告、结构化产物解析报告 | `qa_verdict.json` |
| `release` 门禁 | QA verdict、JAR 候选产物、文档索引 | `release_decision.json` |

模板实现应集中在 `task-plan-gates.ts` 或其旁路模块，并由测试覆盖。后续新增模板必须同步补测试，避免自然语言文件名误识别造成错误派发。

## 7. manual_gate 拆分设计

### 7.1 现状问题

当前“门禁放行继续”只有一个动作：写入 `manualGateReleases`，随后调度器把该 `manual_gate` 任务当作普通 ready task 派发给 AO。

这造成两个问题：

1. 用户理解的“放行”是“人工批准并继续”，但系统行为是“批准后再派发该门禁任务”。
2. 如果该门禁任务本身是 reviewer，AO 会要求可审计对象和输出产物；但用户刚刚的放行并没有生成这些产物。

### 7.2 新动作一：门禁放行

按钮文案：

```text
门禁放行
```

语义：

> 人工确认当前 `manual_gate` 已通过，由控制平面直接生成门禁决策产物，把该门禁任务标记为 completed，并继续调度后续任务。

状态迁移：

```text
waiting_manual_gate
  -- 门禁放行 -->
running
  当前 manual_gate task.status = completed
  currentTaskId = null
  manualGateReleases += approved
  generated gate artifacts
```

控制平面生成产物：

```text
{artifactDir}/{gate_decision_file}
{artifactDir}/{approved_flag_file}
```

例如 `TASK-002`：

```text
C:\workspace\fast-transport\.ao-control-plane\WF-20260630T031508Z\g0_review_gate_decision.json
C:\workspace\fast-transport\.ao-control-plane\WF-20260630T031508Z\g0_approved.flag
```

`g0_review_gate_decision.json` 示例：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "taskId": "TASK-002",
  "decision": "approved",
  "decidedBy": "user",
  "decidedAt": "2026-07-06T00:00:00.000Z",
  "rationale": "Web UI 门禁放行",
  "source": "control_plane_manual_gate",
  "dependencyEvidence": [
    {
      "taskId": "TASK-001",
      "path": "C:\\workspace\\fast-transport\\.ao-control-plane\\WF-20260630T031508Z\\g0_repo_reality_check.json"
    }
  ]
}
```

`g0_approved.flag` 内容建议：

```text
approved
workflowId=WF-20260630T031508Z
taskId=TASK-002
decidedAt=2026-07-06T00:00:00.000Z
```

该动作不调用 AO。

门禁放行产物由新增的 `src/workflow/ao-dispatch-context.ts` 统一合成。该模块提供 `synthesizeManualGateArtifacts(state, taskId, artifactDir)`，负责基于当前状态、任务计划、依赖产物和用户理由生成 gate decision、flag 等文件内容；`execution-jobs.ts` 只负责调用该模块并组织 Web/API 流程，`continuous-plan-execution.ts` 只负责状态迁移。

写入顺序必须保证可恢复：

1. 校验当前门禁任务、依赖任务和必需输入产物。
2. 将 gate decision、flag 写入临时文件，例如 `g0_review_gate_decision.json.tmp-{dispatchId}`。
3. 临时文件写入成功后，原子 rename 到正式文件名；如果 Windows 上目标文件导致首次 rename 失败，允许先删除同名目标文件再重试一次，仍失败则进入 `manual_gate_artifact_write_failed`。
4. 调用 `store.update`，在同一次状态迁移中把门禁 task 标为 `completed`，写入 `manualGateReleases[].generatedArtifacts`，并清理 `currentTaskId/failure`。
5. 追加 `manual_gate_approved` 日志。

如果第 4 步状态迁移失败，catch 路径必须删除本次刚写入的正式文件和临时文件，并追加 `manual_gate_artifact_write_failed` 日志；如果删除失败，错误信息必须提示悬空产物路径，由人工处理。重复请求时，如果状态中已经存在同一 taskId、同一 mode、同一 attempt 的 release，直接返回当前 snapshot，不再次写文件。

### 7.3 新动作二：派发门禁复核

按钮文案：

```text
派发门禁复核
```

语义：

> 当前门禁需要 AO reviewer 独立审查，由调度器派发 AO，并把控制平面上下文包和待审产物路径传给 AO。

状态迁移：

```text
waiting_manual_gate
  -- 派发门禁复核 -->
running
  currentTaskId = manual_gate taskId
  task.status = working
  aoSessionId = new session
```

与旧“门禁放行继续”的差异：

- 该动作会调用 AO。
- prompt 必须包含 `dispatch-context` manifest。
- AO 需要产出 gate decision 文件和 flag。
- AO report completed 后，调度器必须校验 gate 产物是否存在。

### 7.4 新动作三：门禁要求重规划

按钮文案：

```text
门禁要求重规划
```

语义保持不变：

- 不调用 AO。
- 写入 `manualGateReleases.decision = "requires_replan"`。
- 状态进入 `paused_for_replan`。
- 生成或准备任务计划修订请求。

### 7.5 新动作四：门禁标记阻断

按钮文案：

```text
门禁标记阻断
```

语义保持不变：

- 不调用 AO。
- 写入 `manualGateReleases.decision = "blocked"`。
- 状态进入 `failed`。
- failure.kind = `manual_gate_blocked`。

## 8. API 设计

### 8.1 门禁放行

新增或调整现有接口：

```text
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/approve
```

请求：

```json
{
  "projectRoot": "C:\\workspace\\fast-transport",
  "rationale": "人工确认 G0 校准产物可作为后续计划输入",
  "generateArtifacts": true
}
```

行为：

1. 校验当前 state 必须是 `waiting_manual_gate`。
2. 校验 `currentTaskId === taskId`。
3. 校验依赖任务已完成。
4. 解析该门禁的预期输出产物。
5. 生成 gate decision 和 flag。
6. 将该 task 标记为 `completed`。
7. 写入 `manual_gate_approved` 日志。
8. 启动 runner 继续调度下一个任务。

幂等规则：

- 以 `taskId + mode + attempt` 作为幂等键，`mode = "manual_approve"`。
- 如果已存在同一幂等键的 `manualGateReleases`，接口返回 200 和当前 snapshot，不重复生成产物。
- 如果产物已存在但状态未记录本次 release，必须校验文件 `source = "control_plane_manual_gate"` 且内容匹配当前 taskId；匹配时可补状态，不匹配时进入 `manual_gate_artifact_write_failed`。
- 多浏览器标签同时点击时，必须依赖 `store.update` 的串行事务做二次校验。

### 8.2 派发门禁复核

新增接口：

```text
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/dispatch-review
```

请求：

```json
{
  "projectRoot": "C:\\workspace\\fast-transport",
  "rationale": "需要 AO reviewer 独立复核 G0 校准产物"
}
```

行为：

1. 校验当前 state 必须是 `waiting_manual_gate`。
2. 校验 `currentTaskId === taskId`。
3. 在 `store.update` 中预留 `dispatchId`、`attempt`、`dispatchContextPath` 和 `pendingDispatch`，并再次校验没有同一 `taskId + mode + attempt` 的 release。
4. 在事务外生成 dispatch context manifest。
5. 在事务外增强 AO prompt 并调用 AO spawn。
6. spawn 成功后再次 `store.update`，将 task.status 置为 `working`，写入 `aoSessionId`、`dispatchContextPath`、`manualGateReleases[].mode = "ao_review"`。
7. 写入 `manual_gate_review_dispatched` 日志。

AO spawn 必须在 `store.update` 事务之外执行，避免长时间持有状态锁；但 dispatchId、attempt 和 dispatchContextPath 必须先进入状态，沿用现有 dispatch reserved 模式，保证崩溃后可以通过 pendingDispatch 恢复或中断，并能定位孤儿 manifest。

幂等规则：

- 以 `taskId + mode + attempt` 作为幂等键，`mode = "ao_review"`。
- 如果同一幂等键已绑定 `aoSessionId`，重复请求直接返回当前 snapshot，不再次 spawn。
- 如果 manifest 已写入但 spawn 失败，清理 pendingDispatch 和本次生成的 manifest，并以 `ao_spawn_failed` 或 `artifact_context_missing` 进入人工处理。

### 8.3 兼容现有 decision 接口

现有接口：

```text
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/decision
```

建议兼容策略：

- `decision = "approved"`：迁移为“门禁放行”，不再派发该 task。
- `decision = "requires_replan"`：保持“门禁要求重规划”。
- `decision = "blocked"`：保持“门禁标记阻断”。
- 新 UI 不再直接使用 `decision=approved` 的旧语义。

## 9. 状态机设计

### 9.1 状态字段扩展

`manualGateReleases[]` 建议扩展：

```json
{
  "taskId": "TASK-002",
  "decision": "approved",
  "mode": "manual_approve",
  "rationale": "Web UI 门禁放行",
  "releasedAt": "2026-07-06T00:00:00.000Z",
  "generatedArtifacts": [
    "g0_review_gate_decision.json",
    "g0_approved.flag"
  ]
}
```

如果是派发复核：

```json
{
  "taskId": "TASK-002",
  "decision": "review_dispatched",
  "mode": "ao_review",
  "rationale": "派发 AO reviewer 独立复核",
  "releasedAt": "2026-07-06T00:00:00.000Z",
  "aoSessionId": "ft-2",
  "dispatchContextPath": "dispatch-context/ao-dispatch-context-TASK-002-attempt-1.json"
}
```

`execution-state` schema 必须同步升级到 zod 显式校验，新增字段均为兼容可选字段：

- `manualGateReleases[].mode?: "manual_approve" | "ao_review"`。
- `manualGateReleases[].generatedArtifacts?: string[]`。
- `manualGateReleases[].dispatchContextPath?: string`。
- `manualGateReleases[].aoSessionId?: string`。
- `manualGateReleases[].attempt?: number`。
- `supersededSessions?: string[]`，用于忽略旧语义产生的 AO session。

读取老状态时不做一次性磁盘迁移，而是在内存归一化时 lazily 补默认值：缺失 `mode` 且 `decision = "approved"` 的 release 按历史兼容规则处理；缺失 `generatedArtifacts` 不直接失败，只有执行到对应门禁恢复或输出校验时再补齐或阻断。

### 9.2 调度规则调整

当前规则：

```text
manual_gate 已 release 后，manual_gate task 可作为 next ready task 被派发。
```

调整为：

```text
manual_gate 未处理：
  runner 进入 waiting_manual_gate。

manual_gate 被人工放行：
  task 直接 completed。
  runner 继续找后续任务。

manual_gate 被派发复核：
  task 进入 working。
  AO 完成且 gate 产物校验通过后，task completed。

manual_gate 要求重规划：
  state = paused_for_replan。

manual_gate 标记阻断：
  state = failed。
```

也就是说，`manualGateReleases.approved` 不再意味着“可以派发该门禁任务”，而是意味着“该门禁任务已经由人工完成”。

## 10. AO prompt 增强规则

### 10.1 增强入口

在 `ContinuousExecutionRunner` 准备调用 AO 前，统一调用：

```ts
buildAoDispatchPrompt({
  task,
  plan,
  state,
  projectRoot,
  artifactDir,
  attempt
})
```

返回：

```ts
{
  prompt: string;
  contextPath: string;
  missingRequiredArtifacts: MissingArtifact[];
}
```

prompt 模板使用中英双语标题和稳定英文 key，保证页面可读性和 AO 可解析性：

- 中文解释用于说明任务语义。
- `projectRoot`、`artifactDir`、`workflowId`、`coreInputs`、`dependencyArtifacts`、`expectedOutputs` 等 key 固定使用英文。
- Windows 和 POSIX 路径都通过 `path.normalize` 生成，并由 `JSON.stringify` 写入 manifest，避免反斜杠、盘符、空格和 Unicode 路径被破坏。

### 10.2 缺失产物处理

如果缺少必需输入产物：

- 普通任务：默认中断为 `blocked_for_human`，允许用户重试、人工标记完成、提交重规划请求。
- 派发门禁复核：必须中断，不允许无证据派发 AO reviewer。
- 用户可以通过“提交重规划请求”修复计划，或补齐产物后重试。

失败类型建议：

```text
artifact_context_missing
```

错误信息必须包含：

- 缺失文件绝对路径。
- 关联 taskId。
- 缺失产物 kind。
- 建议动作。

`failure.kind` 必须有权威定义，建议新增 `src/workflow/execution-failure.ts` 或 `src/schemas/execution-state.ts` 中的 zod 枚举。新增和既有 kind 统一为：

| kind | 含义 | UI 恢复动作 |
| --- | --- | --- |
| `ao_spawn_failed` | AO 派发失败 | 重试任务、提交重规划请求 |
| `ao_session_missing` | AO session 丢失或未返回 | 重试任务、人工标记完成、提交重规划请求 |
| `manual_gate_requires_replan` | 门禁要求重规划 | 提交重规划请求 |
| `manual_gate_blocked` | 门禁明确阻断 | 提交重规划请求或停止 |
| `dependency_deadlock` | 依赖无可推进路径 | 提交重规划请求 |
| `artifact_context_missing` | 必需输入产物缺失 | 补齐产物后重试、提交重规划请求 |
| `artifact_output_missing` | AO completed 后必需输出产物缺失 | 重试任务、人工标记完成、提交重规划请求 |
| `artifact_output_conflict` | AO completed 后输出产物存在，但 `source`、`aoSessionId` 或执行模式冲突 | 人工处理产物后重试、人工标记完成、提交重规划请求 |
| `manual_gate_artifact_write_failed` | 控制平面生成门禁产物失败或悬空 | 人工处理文件后重试、提交重规划请求 |

执行日志类型也必须纳入同一枚举或 zod schema，新增 `ao_dispatch_context_created`、`manual_gate_approved`、`manual_gate_review_dispatched`、`artifact_context_missing`、`artifact_output_missing`、`artifact_output_conflict`、`manual_gate_artifact_write_failed` 时，不能只在 UI 文案中出现。读取历史 `execution-log.jsonl` 时，未知旧日志类型必须保留原文并继续展示，不做启动期迁移，也不因未知日志 type 阻断状态读取。

### 10.3 输出产物校验

AO report completed 后，调度器不能只看 AO 状态，还要校验当前任务的 `outputArtifacts`。

规则：

- `required: true` 的输出必须存在。
- 条件性输出按固定顺序校验：先读取并解析 `gate_decision` 或 verdict 主文件，再从该主文件中取 `decision` 等字段求值 `requiredWhen`。
- 如果 `gate_decision` 或 verdict 主文件缺失、JSON 不可解析、缺少条件字段，直接判 `artifact_output_missing`，不再继续求值条件分支。
- `requiredWhen` 的输出按 gate decision 或 verdict 条件校验。
- 缺失或 `requiredWhen` 语法非法时，task 进入 `blocked_for_human`，failure.kind = `artifact_output_missing`。
- 如果 `gate_decision` 文件存在但 `source`、`aoSessionId` 与当前 release.mode 不匹配，task 进入 `blocked_for_human`，failure.kind = `artifact_output_conflict`。
- 页面显示缺失产物列表。
- 校验时以 `artifactDir` 内文件为权威。AO worktree 内的同名文件只视为临时副本，不作为通过依据。
- 控制平面人工放行生成的 gate decision 必须包含 `source: "control_plane_manual_gate"`；AO 复核生成的 gate decision 必须包含 `source: "ao_review"` 和 `aoSessionId`。AO 进程本身可能写入 `artifactDir`，runner 无法在写入前拦截，因此在 AO report completed 后做冲突校验；除非用户显式选择“派发门禁复核”，`source !== "control_plane_manual_gate"` 的文件不得让人工放行路径通过。

## 11. UI 设计

### 11.1 waiting_manual_gate 面板

当前处于 `waiting_manual_gate` 时展示四个动作：

```text
门禁放行
派发门禁复核
门禁要求重规划
门禁标记阻断
```

按钮说明：

| 按钮 | 是否调用 AO | 是否直接完成当前门禁任务 | 适用场景 |
| --- | --- | --- | --- |
| 门禁放行 | 否 | 是 | 人已经完成复核，直接批准继续 |
| 派发门禁复核 | 是 | 否 | 需要 AO reviewer 独立审查上游产物 |
| 门禁要求重规划 | 否 | 否 | 当前证据或计划不足，需要修订计划 |
| 门禁标记阻断 | 否 | 否 | 当前门禁明确不通过，执行中断 |

### 11.2 上下文预览

等待门禁时，页面应显示：

- 当前门禁 taskId 和标题。
- 依赖任务。
- 可审查输入产物列表。
- 当前门禁预期输出产物列表。
- 缺失产物告警。

示例：

```text
当前门禁：TASK-002 / G0 人工复核放行

依赖产物：
✓ TASK-001: g0_repo_reality_check.json

门禁放行将生成：
g0_review_gate_decision.json
g0_approved.flag
```

如果上下文预览发现必需输入产物缺失：

- 禁用“派发门禁复核”。
- 保留“门禁要求重规划”和“门禁标记阻断”。
- 在同一面板提供“提交重规划请求”入口，直接调用 `/revision-requests`，不要要求用户切回失败恢复面板。
- 缺失列表必须展示绝对路径、关联上游 taskId 和产物 kind。

### 11.3 执行日志

页面执行日志新增事件：

- `ao_dispatch_context_created`
- `manual_gate_approved`
- `manual_gate_review_dispatched`
- `artifact_context_missing`
- `artifact_output_missing`

## 12. 当前工作流恢复方案

当前 `WF-20260630T031508Z` 处于：

```text
TASK-001 completed
TASK-002 working
TASK-002 aoSessionId = ft-2
manualGateReleases[TASK-002] = approved
```

但 `ft-2` 实际在等待可审计对象。这是旧语义导致的半错误状态。

推荐恢复路径：

1. 停止或忽略 `ft-2` 的当前 reviewer session。
2. 将 `TASK-002` 从 `working` 修正为 `completed`。
3. 由控制平面生成：
   - `g0_review_gate_decision.json`
   - `g0_approved.flag`
4. 将旧 `aoSessionId = "ft-2"` 移入 `supersededSessions: ["ft-2"]`，并清空 `taskStates[TASK-002].aoSessionId` 或保留到 `manualGateReleases[].supersededAoSessionId` 仅作审计。
5. `manualGateReleases[TASK-002].mode = "manual_approve"`。
6. `currentTaskId = null`。
7. `state.status = "running"`。
8. runner 继续派发 `TASK-004`。

如果 AO CLI 支持 abort/kill，应优先尝试停止 `ft-2`；如果 AO CLI 不支持，应只做语义忽略。后续 AO 状态同步和 report completed 恢复逻辑必须忽略 `supersededSessions` 中的 sessionId，避免旧 `ft-2` 异步上报后覆盖已完成的人工门禁结果。

如果用户希望 AO reviewer 真正复核，则走另一条路径：

1. 清除旧的 `manualGateReleases[TASK-002] = approved` 或标记为 superseded。
2. 重新进入 `waiting_manual_gate`。
3. 点击“派发门禁复核”。
4. 调度器用增强 prompt 派发 AO，并明确传入 `g0_repo_reality_check.json` 路径。

## 13. 代码改造点

### 13.1 新增模块

建议新增：

```text
src/workflow/ao-dispatch-context.ts
```

职责：

- 解析核心输入文件。
- 从任务计划和验收标准推断产物。
- 生成 dispatch context manifest。
- 构造增强 prompt。
- 校验缺失输入产物。
- 校验输出产物。
- 提供 `synthesizeManualGateArtifacts()`，统一生成控制平面人工门禁产物内容和写入计划。
- 提供路径归一化和 Windows/POSIX manifest 序列化测试辅助。

### 13.2 修改连续调度器

修改：

```text
src/workflow/continuous-plan-execution.ts
```

改造点：

- AO spawn 前调用 `buildAoDispatchContext()`。
- `manual_gate` 人工放行不再进入普通 dispatch 逻辑。
- 增加 `approveManualGate()`。
- 增加 `dispatchManualGateReview()`。
- AO completed 后增加输出产物校验。

### 13.3 修改执行任务管理器

修改：

```text
src/web/execution-jobs.ts
```

改造点：

- 新增 `approveManualGate()`。
- 新增 `dispatchManualGateReview()`。
- 兼容旧 `decideManualGate(approved)` 到新“门禁放行”语义。
- snapshot 增加当前门禁上下文预览信息。

### 13.4 修改 Web 路由

修改：

```text
src/web/server.ts
```

新增路由：

```text
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/approve
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/dispatch-review
```

保留旧路由兼容：

```text
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/decision
```

### 13.5 修改 UI

修改：

```text
src/web/ui.ts
```

改造点：

- “门禁放行继续”改为“门禁放行”。
- 新增“派发门禁复核”。
- 显示门禁上下文预览。
- 缺失产物时禁用“派发门禁复核”，但允许“门禁要求重规划”。

### 13.6 修改任务计划生成和归一化

修改：

```text
src/workflow/task-plan-normalizer.ts
src/workflow/task-plan-gates.ts
```

改造点：

- 对 reviewer、manual_gate、QA、release 类任务强制检查产物路径。
- 如果验收标准提到 JSON、flag、report、verdict，但没有结构化 `outputArtifacts`，归一化阶段补齐或要求重规划。
- 如果任务依赖上游产物，但 `inputArtifacts` 缺失，归一化阶段补齐或提示审查失败。

### 13.7 修改 schema、failure kind 和日志枚举

修改：

```text
src/workflow/execution-state-store.ts
src/schemas/task-plan.ts
src/workflow/execution-failure.ts（新增，或等价集中定义）
```

改造点：

- `ExecutionState` 增加 `supersededSessions?: string[]`。
- `manualGateReleases[]` schema 增加 `mode`、`attempt`、`generatedArtifacts`、`dispatchContextPath`、`aoSessionId` 等可选字段。
- `TaskPlan.tasks[]` schema 增加 `inputArtifacts`、`outputArtifacts`。
- 集中定义 `failure.kind` 枚举和 UI 恢复动作映射。
- 集中定义 `ExecutionLogEntry.type` 枚举，包含新增日志类型。
- 老 state 读取时 lazy normalize，不要求启动时批量重写历史文件。

## 14. 数据兼容

### 14.1 老 `manualGateReleases`

老数据：

```json
{
  "taskId": "TASK-002",
  "decision": "approved",
  "rationale": "Web UI 门禁放行继续",
  "releasedAt": "..."
}
```

兼容解释：

- 如果 task.status 是 `pending` 或 `waiting_manual_gate`：按新“门禁放行”处理，直接生成产物并完成该 task。
- 如果 task.status 是 `working` 且已有 AO session：允许用户选择“转换为人工门禁放行”或“重新派发门禁复核”。转换为人工门禁放行时，将旧 `aoSessionId` 写入 `supersededSessions`，并在后续 AO report 处理中忽略该 session。
- 如果旧 release 已经写入但 gate decision/flag 缺失，读取 snapshot 时展示“旧门禁放行缺少审计产物”，引导用户执行一次兼容恢复生成产物。
- 如果旧 release 和 gate decision/flag 都存在，且文件内容能匹配 taskId，可 lazy 补充 `mode = "manual_approve"` 和 `generatedArtifacts`，不强制重写历史 state。

### 14.2 老任务计划

没有 `inputArtifacts` 和 `outputArtifacts` 的计划不直接失败。调度器先用推断规则生成上下文，如果推断失败，再中断并提示修订计划。

## 15. 验证计划

### 15.1 单元测试

新增测试：

1. `manual_gate approve marks task completed without AO spawn`。
2. `manual_gate approve writes gate decision and approved flag`。
3. `manual_gate dispatch-review spawns AO with dispatch context manifest`。
4. `AO prompt includes projectRoot artifactDir core files dependency artifacts`。
5. `missing required dependency artifact blocks dispatch`。
6. `AO completed but missing required output artifact blocks task`。
7. `legacy decision=approved is treated as manual approve`。
8. `old manualGateReleases approved plus working session can be recovered`。
9. `approve cleans up synthesized artifacts when state update fails`。
10. `concurrent approve requests are idempotent`。
11. `superseded AO session report is ignored after manual gate recovery`。
12. `dispatch context manifest preserves Windows paths with spaces and Unicode`。
13. `requiredWhen` 覆盖 `decision=approved`、`decision=approved&&source=ao_review`、`decision=` 空值、缺字段、JSON 不可解析五类输入，并验证非法表达式不会静默跳过。
14. `AO review gate decision source conflict blocks task`，当当前 release.mode = `ao_review` 但 gate decision.source = `control_plane_manual_gate` 时，进入 `artifact_output_conflict`。

legacy state fixture 示例：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "status": "running",
  "currentTaskId": "TASK-002",
  "taskStates": {
    "TASK-001": {
      "taskId": "TASK-001",
      "status": "completed",
      "aoSessionId": "ft-1"
    },
    "TASK-002": {
      "taskId": "TASK-002",
      "status": "working",
      "aoSessionId": "ft-2"
    }
  },
  "manualGateReleases": [
    {
      "taskId": "TASK-002",
      "decision": "approved",
      "rationale": "Web UI 门禁放行继续",
      "releasedAt": "2026-07-05T15:54:58.636Z"
    }
  ],
  "pendingDispatch": null
}
```

### 15.2 Web API 测试

新增测试：

1. `POST /manual-gates/:taskId/approve` 返回 running，并完成门禁 task。
2. `POST /manual-gates/:taskId/dispatch-review` 返回 running，并写入 AO session。
3. 缺少上游产物时 `dispatch-review` 返回 409 或进入 blocked。
4. 页面 HTML 包含“门禁放行”和“派发门禁复核”。
5. 两个并发 `approve` 请求只生成一次 release 和一组 gate 产物。
6. 门禁上下文缺失时，页面展示“提交重规划请求”入口。

### 15.3 当前工作流验证

对 `WF-20260630T031508Z` 验证：

1. `TASK-001` completed。
2. 点击“门禁放行”后生成 `g0_review_gate_decision.json` 和 `g0_approved.flag`。
3. `TASK-002` completed。
4. runner 继续到 `TASK-004`。
5. 不再派发 `TASK-002` 的 AO reviewer，除非用户主动点击“派发门禁复核”。

## 16. 验收标准

本次改造完成后，应满足：

1. AO 任务 prompt 中明确包含 `projectRoot`、`artifactDir`、核心输入文件、依赖产物和预期输出路径。
2. 所有依赖 `.ao-control-plane` 产物的任务都能通过 dispatch context manifest 找到上下文。
3. “门禁放行”不调用 AO，而是直接生成门禁产物并完成当前门禁任务。
4. “派发门禁复核”才调用 AO reviewer，并必须携带待审产物路径。
5. AO report completed 后，调度器会校验当前任务必需输出产物。
6. 缺少上游必需产物时，调度器明确中断并提示缺失路径。
7. 当前 `WF-20260630T031508Z` 可以从 `TASK-002 / ft-2` 的旧语义状态恢复。

## 17. 实施顺序

功能改造本身应一次性完成以下事项，不拆出“只有 prompt 增强”或“只有 UI 拆分”的中间态：

0. 升级 zod schema、failure kind 枚举和日志类型枚举。
1. 增加 AO dispatch context manifest 和 prompt 增强。
2. 增加任务产物模板解析、结构化产物字段和缺失校验。
3. 拆分 UI 动作为“门禁放行”和“派发门禁复核”。
4. 改造 manual_gate 状态机，人工放行直接完成门禁任务。
5. 增加门禁放行产物生成，并保证写文件和状态迁移的清理语义。
6. 增加派发门禁复核 API。
7. 增加 AO completed 后输出产物校验。
8. 增加旧状态兼容和 `supersededSessions` 忽略逻辑。
9. 补齐单元测试、Web API 测试、并发测试、路径测试和旧状态 fixture 测试。

当前 `WF-20260630T031508Z` 的真实恢复验证作为功能改造后的独立操作或独立恢复 PR 执行，不与功能改造提交耦合。原因是恢复会修改真实 workflow 产物和 AO session 语义，应避免把一次性现场数据修复混入通用功能变更。

## 18. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 自动推断产物不准确 | 优先使用结构化 `inputArtifacts/outputArtifacts`，推断失败时中断并要求重规划 |
| 人工放行生成的 gate 文件缺少审计性 | gate decision 文件记录操作者、时间、理由、依赖证据路径 |
| AO reviewer 仍只看 worktree | prompt 和 manifest 都明确要求读取 artifactDir，并列出绝对路径 |
| 旧任务计划没有产物字段 | 通过兼容推断和内置模板过渡 |
| 老状态中已有错误 AO session | 提供恢复逻辑，将旧 approved manual_gate 转换为人工放行完成 |
| 旧 session 仍可能在后台运行 | 若 AO CLI 支持 abort/kill 则停止；否则写入 `supersededSessions` 并在状态同步、report completed 恢复时忽略 |
| AO 在 worktree 内创建本地产物副本，与 `artifactDir` 不一致 | manifest 明确 `artifactDir` 为权威，输出校验只读取 `artifactDir` |
| 控制平面生成的 gate decision 被后续 AO 覆盖 | 人工放行产物带 `source: "control_plane_manual_gate"`，除非显式派发门禁复核，否则拒绝用 AO 产物覆盖 |
| 大量历史 state 缺失新字段 | 读取时 lazy normalize，不做启动期批量迁移 |
| Windows 路径、空格、Unicode 路径序列化错误 | `ao-dispatch-context.ts` 使用 `path.normalize` 和 `JSON.stringify`，测试覆盖 Windows/POSIX |

## 19. 审查整改决议

本轮审查报告中的 P0、P1 和次要建议全部采纳，没有保留不改项。

整改对应关系：

| 审查项 | 处置 |
| --- | --- |
| P0：manual_gate 产物归属与原子性 | 已明确由 `ao-dispatch-context.ts` 合成产物，采用临时文件、原子 rename、状态迁移失败清理和失败日志 |
| P0：failure kind 与日志枚举 | 已新增 schema、failure kind、日志类型枚举升级要求 |
| P1：`requiredWhen` 语义 | 已补充最小语法、求值顺序和主决策文件缺失处理 |
| P1：产物推断稳定性 | 已收敛为结构化字段优先、仅内置模板可推断，自然语言只作辅助证据 |
| P1：并发与幂等 | 已补充 `taskId + mode + attempt` 幂等键、重复请求 200 返回、spawn 事务外执行规则 |
| P1：`ft-2` 清理 | 已补充 `supersededSessions`、AO abort/kill 边界和旧 report 忽略规则 |
| 次要建议 | 已补充双语 prompt key、`dispatch-context` 子目录说明、zod schema 升级、门禁页重规划入口、legacy fixture、实施顺序 schema 前置、review-loop 非目标、风险和验证项 |

## 20. 最终结论

本问题的根因不是 AO 单次误判，而是控制平面产物目录没有被系统性传入 AO 派发上下文，同时 `manual_gate` 的“人工放行”和“派发 reviewer 复核”混成了一个动作。

整改后，连续任务调度器应形成清晰边界：

- 需要人拍板时，使用“门禁放行”，控制平面直接完成门禁并生成审计产物。
- 需要 AO 独立复核时，使用“派发门禁复核”，调度器必须把待审产物路径和上下文 manifest 明确交给 AO。
- 所有 AO 任务都通过统一上下文桥接获得 `projectRoot`、`artifactDir`、上游产物和预期输出，避免只看 AO worktree 导致误判。

## 21. 执行期模板与条件分支补充

本轮实现补齐了连续执行阶段暴露出的两个语义缺口：条件性回流任务自动跳过，以及领域门禁的上下文产物桥接。模板定义集中在 `src/workflow/task-artifact-templates.ts`，`ao-dispatch-context.ts` 和 `task-plan-normalizer.ts` 共同引用该表，避免归一化阶段与运行期派发阶段继续出现模板漂移。

### 21.1 内置门禁模板

当前内置 `manual_gate` 模板如下：

| gateId | 任务特征 | 决策文件 | 放行标记 | 回流文件 |
| --- | --- | --- | --- | --- |
| `g0` | `G0 人工复核放行` | `g0_review_gate_decision.json` | `g0_approved.flag` | `g0_replan_request.json` |
| `ipc_contract` | `IPC 契约人工复核门禁` | `ipc_contract_review_gate_decision.json` | `ipc_contract_approved.flag` | `ipc_contract_rework_request.json` |
| `transport_contract` | `共享传输抽象契约人工复核门禁` | `transport_contract_review_gate_decision.json` | `transport_contract_approved.flag` | `transport_contract_rework_request.json` |
| `outbound_contract` | `OutboundTransport 契约人工复核门禁` | `outbound_contract_review_gate_decision.json` | `outbound_contract_approved.flag` | `outbound_contract_rework_request.json` |
| `platform_adapter` | `平台适配器人工复核门禁` | `platform_adapter_review_gate_decision.json` | `platform_adapter_approved.flag` | `platform_adapter_rework_request.json` |
| `jar_api_contract` | `JAR 公开 API 契约人工复核门禁` | `jar_api_contract_review_gate_decision.json` | `jar_api_contract_approved.flag` | `jar_api_contract_rework_request.json` |
| `shared_boundary` | `共享文件边界人工门禁` | `shared_boundary_review_gate_decision.json` | `shared_boundary_approved.flag` | `shared_boundary_rework_request.json` |
| `release` | `最终发布人工复核门禁` | `release_review_gate_decision.json` | `release_approved.flag` | `release_rework_request.json` |

### 21.2 内置输出产物模板

当前内置输出产物模板如下：

| 任务特征 | 输出产物 |
| --- | --- |
| `仓库现实校准` | `g0_repo_reality_check.json` |
| `治理门禁决策文件`、`gate 文件`、`回流规范` | `gate_governance_freeze.json`、`gate_governance_freeze.md`、`gate_decision_schema.json`、`qa_verdict.json` |
| `跨语言 IPC 核心字节布局契约` | `ipc_byte_layout_freeze.json`、`ipc_byte_layout_freeze.md`、`ipc_byte_layout_qa_verdict.json` |
| `共享传输抽象与平台边界` | `transport_contract_freeze.json`、`transport_contract_freeze.md` |
| `OutboundTransport 发送契约` | `outbound_contract_freeze.json`、`outbound_contract_freeze.md` |
| `平台适配器统一接口与状态映射契约` | `platform_adapter_contract.json` |
| `JDK 21 JAR 公开 API 与示例依赖契约` | `jar_api_contract_freeze.json` |
| `跨平台后端特性矩阵与共享夹具契约` | `shared_boundary_manifest.json` |
| `统一发布前 QA verdict 汇总裁决` | `unified_qa_verdict.json` |
| `统一 QA verdict 失败回流重规划` | `qa_verdict_rework_request.json` |
| `发布驳回回流重规划` | `release_rework_request.json` |
| `发布二进制候选产物归档` | `release_binary_archive.json` |
| `发布文档与证据索引归档` | `release_docs_evidence_archive.json` |
| `回滚预案与回滚验证入口` | `rollback_plan.json` |

### 21.3 决策类产物字段约定

决策类 JSON 产物必须使用稳定字段名，调度器据此判断后续条件分支：

- 门禁决策文件使用 `decision` 字段，合法值为 `approved`、`rework_required`、`rejected`。
- QA 或发布裁决文件使用 `verdict` 字段，合法值为 `pass`、`fail`。
- 人工放行产物必须包含 `source: "control_plane_manual_gate"`。
- AO 复核门禁产物必须包含 `source: "ao_review"` 和当前 `aoSessionId`。

运行期条件跳过只读取 `decision` 和 `verdict`。如果产物使用 `outcome`、`status`、`result` 等字段，调度器不会把它当作可判定分支，任务会继续按阻断或人工处理路径走。

### 21.4 条件分支跳过语义

条件性回流任务不是普通必跑任务。调度器在每轮 `tick()` 中完成 AO 状态同步后，会扫描依赖已完成的 `pending` 任务：

- 如果任务文本声明 `approved 路径不派发`，并且上游门禁 `decision=approved`，该任务置为 `superseded`。
- 如果任务文本声明 `pass 路径不派发`，并且上游裁决 `verdict=pass`，该任务置为 `superseded`。
- 被跳过任务写入 `task_skipped` 执行日志，日志包含 `taskId`、上游 `dependencyTaskId` 和实际 `outcome`。
- 工作流完成判定使用 `completed + superseded === plan.tasks.length`，因此被跳过的条件分支不会造成执行死锁。

为了避免自然语言约定漂移，任务计划归一化阶段会校验“依赖上游 `manual_gate` 的条件性 `manual_gate` 分支”是否明确写出跳过约定。缺少 `仅在上游非 approved 时触发，approved 路径不派发` 或 `仅在 verdict=fail 时触发，pass 路径不派发` 这类语义时，归一化失败并要求修订任务计划。

### 21.5 校验顺序

条件跳过发生在输出产物校验之后、下一任务派发之前：

1. AO working 任务先同步 AO 状态。
2. AO report completed 的任务先校验 `outputArtifacts`。
3. 已完成依赖的条件性回流任务根据上游 `decision` 或 `verdict` 判断是否 `superseded`。
4. 调度器再计算是否整体完成，或派发下一个 ready task。

这个顺序保证了：只有上游决策产物真实存在、且状态已经完成时，调度器才会跳过条件分支；不会因为缺少证据而静默越过回流任务。
