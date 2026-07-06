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

### 6.2 兼容旧计划

为兼容现有计划，调度器先从以下来源推断产物：

1. `inputArtifacts` 和 `outputArtifacts` 字段。
2. `acceptanceCriteria` 中出现的文件名。
3. `aoPrompt` 中出现的文件名。
4. 内置门禁模板映射。

内置映射示例：

| 任务特征 | 输入产物 | 输出产物 |
| --- | --- | --- |
| `G0 人工复核放行` | `g0_repo_reality_check.json` | `g0_review_gate_decision.json`、`g0_approved.flag` |
| `QA verdict` | 各平台测试报告、结构化产物解析报告 | `qa_verdict.json` |
| `release` 门禁 | QA verdict、JAR 候选产物、文档索引 | `release_decision.json` |

如果推断不确定，调度器不应静默派发，应在 UI 和日志中显示“上下文产物不完整”，并允许用户选择补充、重规划或强制派发。

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
3. 生成 dispatch context manifest。
4. 增强 AO prompt。
5. 调用 AO spawn。
6. task.status = `working`。
7. 写入 `manual_gate_review_dispatched` 日志。

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

### 10.3 输出产物校验

AO report completed 后，调度器不能只看 AO 状态，还要校验当前任务的 `outputArtifacts`。

规则：

- `required: true` 的输出必须存在。
- `requiredWhen` 的输出按 gate decision 或 verdict 条件校验。
- 校验失败时，task 进入 `blocked_for_human`，failure.kind = `artifact_output_missing`。
- 页面显示缺失产物列表。

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
4. `manualGateReleases[TASK-002].mode = "manual_approve"`。
5. `currentTaskId = null`。
6. `state.status = "running"`。
7. runner 继续派发 `TASK-004`。

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
- 如果 task.status 是 `working` 且已有 AO session：保留 session 记录，但允许用户选择“转换为人工门禁放行”或“重新派发门禁复核”。

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

### 15.2 Web API 测试

新增测试：

1. `POST /manual-gates/:taskId/approve` 返回 running，并完成门禁 task。
2. `POST /manual-gates/:taskId/dispatch-review` 返回 running，并写入 AO session。
3. 缺少上游产物时 `dispatch-review` 返回 409 或进入 blocked。
4. 页面 HTML 包含“门禁放行”和“派发门禁复核”。

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

本次应一次性完成以下事项，不拆成下阶段：

1. 增加 AO dispatch context manifest 和 prompt 增强。
2. 增加任务产物推断与缺失校验。
3. 拆分 UI 动作为“门禁放行”和“派发门禁复核”。
4. 改造 manual_gate 状态机，人工放行直接完成门禁任务。
5. 增加门禁放行产物生成。
6. 增加派发门禁复核 API。
7. 增加 AO completed 后输出产物校验。
8. 增加旧状态恢复逻辑。
9. 补齐单元测试和 Web API 测试。
10. 对当前工作流执行一次针对性恢复验证。

## 18. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 自动推断产物不准确 | 优先使用结构化 `inputArtifacts/outputArtifacts`，推断失败时中断并要求重规划 |
| 人工放行生成的 gate 文件缺少审计性 | gate decision 文件记录操作者、时间、理由、依赖证据路径 |
| AO reviewer 仍只看 worktree | prompt 和 manifest 都明确要求读取 artifactDir，并列出绝对路径 |
| 旧任务计划没有产物字段 | 通过兼容推断和内置模板过渡 |
| 老状态中已有错误 AO session | 提供恢复逻辑，将旧 approved manual_gate 转换为人工放行完成 |

## 19. 最终结论

本问题的根因不是 AO 单次误判，而是控制平面产物目录没有被系统性传入 AO 派发上下文，同时 `manual_gate` 的“人工放行”和“派发 reviewer 复核”混成了一个动作。

整改后，连续任务调度器应形成清晰边界：

- 需要人拍板时，使用“门禁放行”，控制平面直接完成门禁并生成审计产物。
- 需要 AO 独立复核时，使用“派发门禁复核”，调度器必须把待审产物路径和上下文 manifest 明确交给 AO。
- 所有 AO 任务都通过统一上下文桥接获得 `projectRoot`、`artifactDir`、上游产物和预期输出，避免只看 AO worktree 导致误判。
