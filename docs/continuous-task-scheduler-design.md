# 连续任务调度器设计方案

## 1. 背景

当前 AO Control Plane 的任务执行入口是一次性派发逻辑。用户点击“派发执行”后，系统通过 `ArtifactStore` 读取 `.ao-control-plane/<workflowId>/task-plan.json`，扫描当前所有任务，只派发此刻依赖已满足的 `pending` 任务。派发完成后，控制平面不会持续等待该任务完成，也不会自动派发后续任务。

以 `WF-20260630T031508Z` 为例，任务计划已经通过审查，`planReadiness` 为 `gated_implementable`，共有 105 个任务，但审批报告显示当前可派发任务只有 1 个。首次点击“派发执行”时，只会派发 `TASK-001`，后续 104 个任务会因为依赖未完成或 `manual_gate` 未放行而等待。

目标是将“派发执行”升级为“启动连续执行”：点击一次后，调度器按照任务计划顺序、依赖关系、执行状态和 AO session 状态持续推进；一个任务完成后自动派发下一个可执行任务；直到所有任务完成，或者某个任务失败、中断、需要人工门禁或需要修订任务计划。

## 2. 设计目标

1. 点击“启动连续执行”后创建后台 execution job，而不是只进行单轮派发。
2. 调度器按 `task-plan.json` 或当前生效的 `task-plan-v{N}.json` 顺序串行派发任务。
3. 本次只实现严格串行调度，同一时间最多一个任务处于 `working`。
4. 调度器持续监视 AO session 状态，任务完成后继续推进。
5. 任一任务确认失败、卡住或需要人工输入时，中断连续执行。
6. 遇到 `manual_gate` 时暂停，等待用户通过 Web UI 做结构化决策。
7. 支持页面刷新、Web 进程重启、控制台关闭后的断点续跑。
8. 支持在确认任务计划本身有问题时生成修订版任务计划，并迁移执行状态后继续执行。
9. 不引入额外 agent 参与调度决策。结合当前项目代码和本需求，连续调度、状态监视、断点续跑、门禁暂停、失败中断和计划修订入口都可以由确定性代码完整实现。

## 3. 非目标

1. 不让调度器自行修改设计稿或直接改写已批准计划。
2. 不让调度器绕过 `manual_gate`。
3. 不让调度器指定具体 agent、model、provider、Codex 或 ClaudeCode。
4. 不实现并发调度。
5. 不把执行状态直接写回批准后的任务计划文件。
6. 不把测试、审查、提交逻辑内置到控制平面。控制平面只负责派发、监视和状态推进，具体执行仍由 AO worker 根据 `aoRole`、`aoPrompt`、`acceptanceCriteria` 和 `executionPolicy` 完成。

## 4. 当前执行模型

当前核心逻辑位于：

- `src/workflow/plan-execution.ts`
- `src/adapters/ao.ts`
- `src/web/server.ts`
- `src/web/ui.ts`
- `src/workflow/ao-status.ts`
- `src/web/artifact-store.ts`

现有行为：

1. Web UI 调用 `/api/ao/execute`。
2. Server 通过 `ArtifactStore` 读取 `.ao-control-plane/<workflowId>/task-plan.json`。
3. `executePlan()` 扫描所有任务。
4. 对每个 `pending` 任务判断依赖是否满足。
5. 满足条件的任务调用 `ao spawn --role <aoRole> --prompt <aoPrompt>`。
6. 返回本轮派发的 sessions 和 blockedTasks。

该模型的问题是：它只做一轮快照式派发，不会持续监视 AO session，也不会自动推进后续任务。

## 5. 无额外 agent 的可行性

本需求不需要额外 agent 参与调度决策。原因是连续任务调度器要解决的是流程控制问题，而不是开放式推理问题。当前项目已经具备实现该需求所需的代码基础：

1. 任务计划已经包含任务顺序、依赖、`dependencyCondition`、`aoRole`、`aoPrompt`、`acceptanceCriteria` 和 `executionPolicy`。
2. `src/workflow/plan-execution.ts` 已经具备任务 readiness 判断和单轮派发能力。
3. `src/adapters/ao.ts` 已经封装 `ao spawn` 和 `ao session ls`。
4. `src/workflow/ao-status.ts` 已经具备 AO session 到任务状态的映射能力。
5. `src/web/server.ts` 和 `src/web/ui.ts` 已经具备 Web 触发派发和展示执行结果的基础。

调度器可以完全用代码实现：

1. 按当前生效任务计划顺序扫描任务。
2. 按依赖图和 `execution-state.json` 判断是否可执行。
3. 派发 AO 内置角色。
4. 轮询 AO session。
5. 将 terminal success 映射为 `completed`。
6. 将经过确认窗口后的 failed、stuck、ci_failed、needs_input 映射为中断。
7. 按 `dependencyCondition === "manual_gate"` 暂停并等待结构化门禁决策。
8. 按 `execution-state.json` 恢复执行。
9. 在计划错误时进入版本化修订流程。

这里的“完全做到”有明确边界：控制平面可以完整实现调度、监视、恢复、门禁、修订入口和状态迁移；具体代码修改、测试执行、审查、提交仍由 AO worker 执行。控制平面不需要知道 AO 内部选择了哪个模型或 agent，也不应在任务中指定这些细节。

## 6. 目标执行模型

新增连续任务调度器 `ContinuousExecutionRunner`，作为确定性的后台执行器。本次采用 Web 内嵌 runner 模型：runner 跑在 Web 进程内，但执行真相写入磁盘；Web 进程重启后通过扫描 `execution-state.json` 重建内存 job。

整体流程：

```text
用户点击“启动连续执行”
  ↓
创建或恢复 execution job
  ↓
读取当前生效 task plan 和 execution-state.json
  ↓
同步 AO session 状态
  ↓
是否已有 working 任务？
  ├─ 是：等待下一轮轮询
  └─ 否：选择下一个可执行任务
        ↓
        是否遇到未放行 manual_gate？
        ├─ 是：暂停并进入门禁决策视图
        └─ 否：调用 ao spawn
              ↓
              轮询该任务 AO session
              ↓
              完成则继续下一个任务
              ↓
              确认失败则中断
              ↓
              全部完成则 workflow completed
```

调度器只负责硬规则：

1. 任务顺序。
2. 依赖判断。
3. `manual_gate` 判断。
4. AO 派发。
5. AO 状态轮询。
6. 执行状态持久化。
7. 失败暂停和恢复。

调度器不负责业务判断，也不负责模型选择。

## 7. 核心概念

### 7.1 任务计划

`task-plan.json` 是最初批准后的执行基线。`task-plan-v{N}.json` 是经过修订审查后的新执行基线。连续执行期间不直接修改这些计划文件。如果计划有问题，通过计划修订机制生成新版本。

执行期的任务状态不以任务计划里的 `status` 为准。计划文件中的 `status` 字段只用于历史兼容和初次导入；runner 的 readiness 判断以 `execution-state.json` 的 `taskStates` 为唯一真相源。

### 7.2 执行状态

`execution-state.json` 是运行账本，记录每个任务的运行状态、AO session、失败原因、人工门禁决策、当前 job 状态和当前生效计划版本。

### 7.3 执行日志

`execution-log.jsonl` 记录调度器每一步动作，方便审计和恢复。日志事件必须包含 `attempt` 和 `actor`。

### 7.4 执行 job

Web 侧“启动连续执行”不等待整个执行完成，而是创建后台 execution job。UI 通过轮询 job 状态展示进度。

Web 进程重启后，服务启动逻辑必须扫描 `.ao-control-plane/*/execution-state.json`，将 `status` 为 `running`、`waiting_manual_gate` 或 `paused_for_replan` 的记录重建为可查询并可继续推进的 job。对于 `running` 状态，恢复后先执行 AO session 同步，再决定继续轮询、失败中断或派发下一个任务。

`stopped` 状态也要被扫描出来，但只能重建为只读历史记录，不自动启动 runner。用户必须通过 resume 入口显式恢复，进程重启不能把 `stopped` 自动恢复为 `running`。

启动扫描还必须处理未完成的 `pendingDispatch`：

1. 如果 `pendingDispatch !== null` 且对应任务没有 `aoSessionId`，说明上一次进程可能在预派发后、写入 sessionId 前崩溃。
2. runner 恢复前必须先调用 `ao session ls`，按 workflowId、taskId、prompt、displayName 或 branch 前缀查找可能的孤儿 session。
3. 找到匹配 session 时，将该 session 写入 `taskStates[taskId].aoSessionId`，并按当前 AO 状态恢复任务状态。
4. 找不到匹配 session 时，将 `pendingDispatch` 置为 null，让 runner 在下一 tick 重新派发。
5. 如果存在多个候选 session，将候选 sessionId 写入 `pendingDispatch.spawnCandidateSessionIds`，job 进入 `failed`，错误类型为 `state_corrupted`，等待人工排障，避免重复派发。

## 8. 文件产物设计

workflow 目录下新增：

```text
.ao-control-plane/<workflowId>/execution-state.json
.ao-control-plane/<workflowId>/execution-log.jsonl
.ao-control-plane/<workflowId>/execution.lock
.ao-control-plane/<workflowId>/task-plan-v{N}.json
.ao-control-plane/<workflowId>/task-plan-amendment-{N}.json
.ao-control-plane/<workflowId>/task-plan-review-v{N}-{round}.json
.ao-control-plane/<workflowId>/execution-rebase-report-{N}.json
```

命名规则：

1. `task-plan.json` 表示最初批准执行版，对应 `planVersion = "task-plan-current"`。
2. `task-plan-v{N}.json` 表示第 `N` 次修订后的执行版，从 `N = 2` 开始。
3. `task-plan-amendment-{N}.json`、`task-plan-v{N}.json`、`execution-rebase-report-{N}.json` 共享同一个 revision 编号，单次修订必须配套出现。
4. 多轮修订按已有最大 `N` 加 1。
5. `execution.lock` 用于防止 Web runner 和 CLI runner 同时驱动同一 workflow。

## 9. execution-state.json 结构

初始空状态示例：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "planVersion": "task-plan-current",
  "planPath": "task-plan.json",
  "status": "idle",
  "currentTaskId": null,
  "startedAt": null,
  "updatedAt": "2026-07-04T10:00:00.000Z",
  "completedAt": null,
  "stoppedAt": null,
  "failure": null,
  "taskStates": {},
  "manualGateReleases": []
}
```

运行中状态示例：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "planVersion": "task-plan-current",
  "planPath": "task-plan.json",
  "status": "running",
  "currentTaskId": "TASK-001",
  "startedAt": "2026-07-04T10:00:00.000Z",
  "updatedAt": "2026-07-04T10:05:00.000Z",
  "completedAt": null,
  "stoppedAt": null,
  "failure": null,
  "taskStates": {
    "TASK-001": {
      "taskId": "TASK-001",
      "status": "working",
      "aoRole": "architect",
      "aoSessionId": "SESSION-abc",
      "attempt": 1,
      "maxAttempts": 3,
      "startedAt": "2026-07-04T10:00:00.000Z",
      "completedAt": null,
      "failureReason": null
    }
  },
  "manualGateReleases": []
}
```

建议类型：

```ts
type PlanVersion = "task-plan-current" | `task-plan-v${number}`;

type ExecutionJobStatus =
  | "idle"
  | "running"
  | "waiting_manual_gate"
  | "paused_for_replan"
  | "failed"
  | "completed"
  | "stopped";

type ExecutionTaskRuntimeStatus =
  | "pending"
  | "working"
  | "completed"
  | "blocked_for_human"
  | "failed"
  | "superseded";

type ExecutionErrorKind =
  | "ao_spawn_failed"
  | "ao_status_failed"
  | "ao_task_failed"
  | "ao_task_stuck"
  | "ao_task_needs_input"
  | "manual_gate_blocked"
  | "manual_gate_requires_replan"
  | "revision_requested"
  | "revision_failed"
  | "dependency_deadlock"
  | "plan_missing"
  | "plan_invalid"
  | "state_corrupted"
  | "dispatcher_stopped";

interface ExecutionState {
  workflowId: string;
  planVersion: PlanVersion;
  planPath: string;
  status: ExecutionJobStatus;
  currentTaskId?: string | null;
  startedAt?: string | null;
  updatedAt: string;
  completedAt?: string | null;
  stoppedAt?: string | null;
  failure?: ExecutionFailure | null;
  taskStates: Record<string, ExecutionTaskState>;
  manualGateReleases: ManualGateRelease[];
  pendingDispatch?: PendingDispatch | null;
}

interface ExecutionTaskState {
  taskId: string;
  status: ExecutionTaskRuntimeStatus;
  aoRole: string;
  aoSessionId?: string;
  attempt: number;
  maxAttempts: number;
  startedAt?: string;
  completedAt?: string | null;
  failureReason?: string | null;
  statusObservations?: AoStatusObservation[];
  markedCompletedBy?: {
    actor: "user" | "cli";
    rationale: string;
    at: string;
  };
}

interface AoStatusObservation {
  attempt: number;
  status: string;
  observedAt: string;
}

interface PendingDispatch {
  dispatchId: string;
  taskId: string;
  attempt: number;
  createdAt: string;
  spawnCandidateSessionIds?: string[];
}

interface ExecutionFailure {
  taskId?: string;
  kind: ExecutionErrorKind;
  message: string;
  occurredAt: string;
}
```

`ExecutionStateStore` 必须校验 `planVersion` 白名单：只允许 `task-plan-current` 或实际存在的 `task-plan-v{N}.json`。如果 `planVersion` 指向的计划文件不存在，job 进入 `failed`，错误类型为 `plan_missing`。

## 10. 并发写入与存储一致性

`execution-state.json` 和 `execution-log.jsonl` 是连续执行的真相源，必须避免并发写入覆盖。

实现约束：

1. Web 进程内每个 workflow 只能有一个 `ExecutionStateStore` 单例。
2. `ExecutionStateStore` 内部用 Promise 链或等价异步队列串行化所有读改写操作。
3. runner tick、retry、mark-completed、manual_gate decision、stop、resume、revision request 都必须通过同一个 store 修改状态。
4. 每次写 `execution-state.json` 时先写临时文件，再原子 rename 覆盖目标文件。
5. `execution-log.jsonl` 追加必须经过同一个互斥队列。Windows 下不能假定多请求 `appendFile` 天然原子。
6. CLI runner 和 Web runner 启动前都必须获取 `.ao-control-plane/<workflowId>/execution.lock`；已有有效锁时，另一个 runner 只能以只读 attach 模式观察，不允许同时驱动。
7. `--attach` 不需要获取锁，但只能读取 `execution-state.json` 和 `execution-log.jsonl`，不允许调用任何写接口。
8. `execution-state.json` 解析失败或 zod 校验失败时，job 进入 `failed`，错误类型为 `state_corrupted`，不得继续派发。
9. `planVersion` 指向的计划文件存在，但 `task-plan-amendment-{N}.json` 或 `execution-rebase-report-{N}.json` 配套缺失时，job 进入 `failed`，错误类型为 `state_corrupted`，日志必须记录缺失的具体文件。

`execution.lock` 内容 schema：

```ts
interface ExecutionLock {
  holder: "web" | "cli";
  pid: number;
  jobId?: string;
  acquiredAt: string;
  lockFileToken: string;
}
```

陈旧锁判定：

1. 新 runner 发现 lock 文件时，先读取 `holder`、`pid` 和 `acquiredAt`。
2. 判定 pid 存活时，还要校验 `lockFileToken`。锁文件写入时同步写 `.ao-control-plane/<workflowId>/execution.lock.token`，启动时必须确认 token 一致，降低 pid 复用导致误判的概率。
3. 如果持有进程仍存在且 token 一致，必须拒绝启动并提示当前持有者。
4. 如果持有进程不存在，且 `acquiredAt` 距当前时间超过陈旧锁阈值，新 runner 可以覆盖陈旧锁。
5. 如果持有进程不存在但未超过陈旧锁阈值，仍然拒绝启动，避免误判短暂重启。
6. 陈旧锁阈值通过环境变量 `AO_CONTROL_PLANE_STALE_LOCK_MS` 配置，默认 300000 毫秒；CLI 额外支持 `--stale-lock-ms <number>` 覆盖。
7. 正常停止、完成或失败时，持锁方负责释放 lock。
8. Web 服务启动时也必须获取锁，与 CLI 对等，避免多个 Web 服务实例对同一 artifactRoot 双驱动。

所有计划修订产物也必须使用临时文件和原子 rename 写入：

1. `task-plan-v{N}.json`、`task-plan-amendment-{N}.json`、`execution-rebase-report-{N}.json` 和 `task-plan-review-v{N}-{round}.json` 写入时，必须先写 `*.tmp-{pid}`。
2. 内容完整写入并校验通过后，再原子 rename 到目标文件名。
3. `task-plan-v{N}.json` 一旦出现，就必须是审查通过的最终版。draft 阶段只能写 `task-plan-v{N}-draft.json`，不允许覆写正式文件名。
4. runner 读取 active plan 时必须使用 atomic read：读取 state，读取计划文件，再确认 state.planVersion 未变化；若变化则丢弃本次计划读取结果并重试。

## 11. 状态机设计

### 11.1 Job 状态

```text
idle
  ↓ start
running
  ↓ all tasks completed
completed

running
  ↓ manual gate reached
waiting_manual_gate
  ↓ approved
running
  ↓ requires_replan
paused_for_replan
  ↓ user abandons revision / revision review exceeds max rounds
failed

running
  ↓ task failed / ao stuck / dispatcher error
failed

running
  ↓ user stop
stopped

stopped
  ↓ resume and current working task still active
running

stopped
  ↓ AO session failed during stop, detected on resume
failed

failed
  ↓ retry current task / mark completed / replan accepted
running
```

### 11.2 Task 状态

```text
pending
  ↓ dispatch
working
  ↓ AO terminal success
completed

working
  ↓ AO terminal failure / needs input / stuck confirmed
blocked_for_human

blocked_for_human
  ↓ retry and attempt <= maxAttempts
working

blocked_for_human
  ↓ human mark completed
completed

pending / blocked_for_human
  ↓ new plan supersedes task
superseded
```

`superseded` 是不可逆状态。任务一旦被新计划替代，不允许再变回 `pending`。

## 12. 调度算法

本次采用严格串行执行，伪代码如下：

```ts
async function runContinuousExecution(input: RunInput): Promise<void> {
  while (true) {
    const stateForPlan = await store.readExecutionState(input.workflowId);
    const plan = await store.readActiveTaskPlan(stateForPlan);

    const decision = await store.update(input.workflowId, async (current) => {
      if (current.status === "stopped") return { action: "return" };
      if (current.planVersion !== stateForPlan.planVersion) return { action: "reload" };

      await syncWorkingTasksWithAo(plan, current);

      const terminal = evaluateTerminalState(plan, current);
      if (terminal) return finishJobInState(current, terminal);

      const workingTask = findWorkingTask(current);
      if (workingTask) return { action: "sleep" };

      const nextTask = findNextReadyTask(plan, current);
      if (!nextTask) return pauseOrFailInState(plan, current);

      if (nextTask.dependencyCondition === "manual_gate" && !isManualGateReleased(nextTask, current)) {
        return pauseForManualGateInState(current, nextTask);
      }

      return reserveDispatchIntentInState(current, nextTask);
    });

    if (decision.action === "return") return;
    if (decision.action === "reload") continue;
    if (decision.action === "sleep") {
      await sleep(input.pollIntervalMs);
      continue;
    }

    if (decision.action === "dispatch") {
      const spawnResult = await ao.spawnTask(decision.task);
      await store.update(input.workflowId, async (current) => {
        return commitDispatchResultInState(current, decision.dispatchId, spawnResult);
      });
    }
  }
}
```

调度 tick 必须遵守：

1. sync、terminal 判断、findWorking、findNextReady、manual_gate 检查和预派发意图都在同一个 `store.update()` 闭包内完成，避免 TOCTOU。
2. `sleep(pollIntervalMs)` 必须在 `store.update()` 闭包外执行，事务不能跨越 sleep。
3. active plan 可在闭包外读取，因为计划文件是不可变基线；进入闭包后必须校验 `current.planVersion` 未变化，若已变化则返回 `reload` 并重读计划。
4. `ao spawn` 属于外部 IO，不在 `store.update()` 闭包内执行。闭包内只写入 `pendingDispatch` 预派发意图，例如 `dispatchId`、taskId、attempt 和 createdAt。
5. `ao spawn` 完成后必须第二次进入 `store.update()`，校验该 `dispatchId` 仍然有效、任务仍然是本次预派发任务，再写入 `aoSessionId` 和 `working`。
6. 如果 `ao spawn` 返回前用户已经 mark-completed、stop 或 replan，第二次 `update()` 必须拒绝写入旧 sessionId，并记录该 spawn 结果被废弃。
7. `syncWorkingTasksWithAo` 不能把可恢复错误直接抛出到 `store.update()` 外。AO 状态查询超过重试阈值时，应在 `current.failure` 中写入 `ao_status_failed`，让状态机处理；只有 JSON 损坏、schema 错误这类状态本身不可读写的问题才应抛出。

`input.signal` 在 Web 进程内由 `WorkflowJobStore` 或新的 `ExecutionJobStore` 持有；跨进程或 CLI 模式下，以 `execution-state.json.status === "stopped"` 表达停止信号，runner 每个 tick 必须重新读取 state 检查。

### 12.1 选择下一个任务

`findNextReadyTask()` 必须遵守：

1. readiness 判断以 `execution-state.json` 的 `taskStates` 为唯一真相源。
2. `task-plan.json` 或 `task-plan-v{N}.json` 的 `status` 字段在执行阶段视为只读，仅用于初次导入。
3. 只考虑 runtime status 为 `pending` 或尚未出现在 `taskStates` 中的计划任务。
4. 已有 `working` 任务时不派发新任务。
5. 按当前生效任务计划中的任务数组顺序扫描。
6. `all_completed`：所有依赖任务都必须是 runtime `completed`。
7. `any_completed`：至少一个依赖任务是 runtime `completed`。
8. `manual_gate`：依赖必须完成，且必须存在 approved 的人工放行记录。
9. `superseded` 任务不可逆，不再参与派发。

G0 校准任务与 G0 门禁不需要新增字段表达。现有 `dependencies + dependencyCondition` 已经足够：G0 校准任务未完成时，manual_gate 任务必须显示为 `waiting_dependencies`，不能进入 `waiting_manual_gate`。

### 12.2 readiness 复用

需要从 `src/workflow/plan-execution.ts` 中抽出纯函数：

```ts
getTaskReadiness(task, completedSet, releasedManualGateSet)
```

连续 runner 和单轮 `executePlan()` 都复用该函数。区别是：

1. 连续 runner 的 `completedSet` 来自 `ExecutionStateStore`。
2. 单轮 `executePlan()` 为兼容旧行为，可以从 plan 中导入初始状态后再计算。

旧 `executePlan()` 不再作为 continuous runner 的状态来源。

### 12.3 同步 AO session

调度器复用 `AoCliAdapter.listSessions()` 和 `ao-status.ts` 的标准状态集合。

状态映射：

```text
AO completed / mergeable / merged / done
  → task completed

AO failed / stuck / ci_failed / needs_input
  → 进入失败观察窗口

其他状态
  → task working
```

失败确认规则：

1. 每次 sync 后向 `statusObservations` 追加当前 AO status、observedAt 和当前 attempt。
2. `statusObservations` 仅保留最近 5 条跨 attempt 观测记录，避免 `execution-state.json` 无界增长。
3. 同一任务的同一 attempt 必须连续 2 次观测到失败类状态，且两次观测间隔不小于 `pollIntervalMs * 0.9`，才确认失败。
4. retry 后第一次观测属于新的 attempt，按首次观测处理，不继承上一 attempt 的失败记录。
5. runner 启动或恢复后第一次观测到 failure 状态时，不算确认失败，必须再等一个轮询周期复测。
6. 失败确认后，任务进入 `blocked_for_human`，job 进入 `failed`。
7. `ao_spawn_failed` 是 spawn 命令直接失败，不进入观察窗口，立即失败。
8. `ao_status_failed` 是状态查询失败，按查询重试策略处理，不等同于任务失败。

AO 状态查询重试策略：

1. 单次 `ao session ls` 失败后最多重试 3 次。
2. 重试使用指数退避，例如 1 秒、2 秒、4 秒。
3. 超过最大重试次数后，job 进入 `failed`，错误类型为 `ao_status_failed`。

### 12.4 派发任务

派发仍使用现有 AO 入口：

```text
ao spawn --role <aoRole> --prompt <aoPrompt>
```

派发后写入：

1. `execution-state.json`。
2. `execution-log.jsonl`。
3. Web job snapshot。

任务计划文件不应因派发被直接修改。

## 13. manual_gate 处理

`manual_gate` 是人工门禁，不应自动放行。但人工门禁不应设计成让用户手动输入命令或手写 JSON。默认交互应是 Web UI 主导的结构化决策，CLI 只作为自动化和排障备用入口。

调度器遇到未放行的 `manual_gate` 时：

1. 前提是该门禁任务的依赖已经全部完成。
2. job 状态改为 `waiting_manual_gate`。
3. `currentTaskId` 指向门禁任务。
4. UI 展示门禁任务、依赖证据、已完成上游任务、关键产物路径和可选动作。

UI 必须提供门禁决策面板，而不是让用户记命令。面板内容包括：

1. 门禁任务标题、taskId、角色、验收标准。
2. 依赖任务完成情况。
3. AO session 链接或 sessionId。
4. 自动发现的关键产物路径。
5. 自动生成的检查清单。每条验收标准对应一个复选项。
6. 三个主按钮：“放行并继续”“要求重规划”“标记阻断”。
7. 一个可选理由输入框，系统根据决策自动填入默认理由，用户可以编辑。

门禁面板必须按任务语义自适应：

1. 如果当前门禁或上游任务属于 G0 校准链路，展示“G0 校准产物清单”分区，例如 `g0_repo_reality_check.json`、真实路径映射、实施类型、阻塞项和 `g0_approved.flag`。
2. 如果当前门禁不是 G0 门禁，不展示 G0 专属产物路径，只展示该门禁依赖任务实际产出的证据。
3. 如果当前任务 `phase === "calibration"`，面板展示校准证据，但不允许把校准任务当作 manual_gate 自动放行。
4. 如果依赖未完成，UI 显示 `waiting_dependencies`，不显示门禁决策按钮。

用户动作：

1. 点击“放行并继续”：写入 `ManualGateRelease { decision: "approved" }`，恢复执行。
2. 点击“要求重规划”：写入 `decision: "requires_replan"`，job 进入 `paused_for_replan`，并生成计划修订请求。
3. 点击“标记阻断”：写入 `decision: "blocked"`，job 进入 `failed`。

重复提交规则：

1. 同一 taskId 已存在 `decision !== "approved"` 的 release 时，再次提交返回 409。
2. 已 `approved` 的 taskId 再次提交 `approved` 视为幂等成功，不写新记录。
3. 已 `approved` 后再提交 `requires_replan` 或 `blocked` 返回 409；需要计划修订时应通过失败处理或修订请求入口发起。

为减少误操作，UI 应实现：

1. 默认禁用“放行并继续”，直到必填检查项完成。
2. 对高风险门禁显示二次确认弹窗，确认内容包含 taskId、决策和影响范围。
3. 决策提交后立即写入 `execution-log.jsonl`。
4. 决策提交后展示“已放行，调度器将继续执行”或“已暂停重规划”的明确结果。
5. 所有命令行等价操作都只作为高级入口，不作为普通用户主路径。

示例：

```json
{
  "taskId": "TASK-002",
  "decision": "approved",
  "rationale": "人工确认 G0 校准产物满足放行条件。",
  "releasedAt": "2026-07-04T10:30:00.000Z"
}
```

## 14. 失败处理

任务失败时，调度器必须停止连续推进，避免后续任务建立在错误前提上继续执行。

UI 提供三个主要动作。

### 14.1 重试当前任务

适用场景：

1. AO worker 异常退出。
2. 临时环境失败。
3. 网络或工具调用抖动。
4. CI 或测试偶发失败。

行为：

1. 当前任务 attempt 加 1。
2. 原 AO session 保留在历史中。
3. 重新调用 `ao spawn`。
4. job 回到 `running`。

约束：

1. 每个任务默认 `maxAttempts = 3`。
2. attempt 超过 `maxAttempts` 时，retry 接口返回 400，引导用户选择“人工确认完成并继续”或“要求修复计划”。
3. `maxAttempts` 是调度层派发次数，不等于 `executionPolicy.maxQaRounds` 或 `maxReviewRounds`。

### 14.2 人工确认完成并继续

适用场景：

1. AO 状态未正确回传，但产物已经存在。
2. 用户人工检查确认验收标准满足。
3. 任务实际完成，但控制平面无法自动识别。

行为：

1. 当前任务 runtime 状态改为 `completed`。
2. 写入 `markedCompletedBy`，包含 actor、rationale 和 at。
3. 写入 `execution-log.jsonl`。
4. job 回到 `running`。

该动作必须要求用户填写非空理由。它不会修改任务计划文件中的 `aoSessionId` 或 `status`，因此不会违反 `task-plan.ts` 的 schema 约束。

### 14.3 要求修复计划

适用场景：

1. 任务依赖漏了。
2. 任务顺序不合理。
3. 验收标准错误。
4. `aoPrompt` 缺少关键上下文。
5. G0 或仓库现实证明设计假设不成立。
6. 当前设计稿和任务计划已无法支撑继续执行。

行为：

1. job 进入 `paused_for_replan`。
2. 生成计划修订请求。
3. 进入任务计划修订流程。

## 15. 计划修订机制

当确认任务计划本身有问题时，不直接覆盖原始 `task-plan.json`。采用版本化修订。

### 15.1 修订产物

```text
task-plan.json
task-plan-amendment-{N}.json
task-plan-v{N}.json
task-plan-review-v{N}-{round}.json
execution-rebase-report-{N}.json
```

含义：

1. `task-plan.json`：原批准执行版。
2. `task-plan-amendment-{N}.json`：为什么需要修订。
3. `task-plan-v{N}.json`：修订后的新计划。
4. `task-plan-review-v{N}-{round}.json`：新计划的审查记录。
5. `execution-rebase-report-{N}.json`：旧执行状态如何迁移到新计划。

### 15.2 修订请求入口

新增接口：

```http
POST /api/ao/execution-jobs/:jobId/revision-requests
```

请求：

```json
{
  "triggerTaskId": "TASK-017",
  "reasonCategory": "dependency_missing",
  "rationale": "TASK-017 依赖的契约冻结任务缺失，当前计划无法继续安全执行。"
}
```

`reasonCategory` 可选值：

```text
dependency_missing
order_invalid
acceptance_invalid
prompt_invalid
g0_invalid
design_invalid
manual_gate_dispute
```

服务端据此生成 `task-plan-amendment-{N}.json` 草稿，再进入任务计划修订审查链路。

修订请求会让 job 进入 `paused_for_replan`，错误类型为 `revision_requested`。如果请求来自失败面板，`currentTaskId` 指向失败任务；如果请求来自 manual_gate 的 `requires_replan`，`currentTaskId` 指向门禁任务。UI 必须根据 `failure.kind` 区分这两种入口。

请求校验规则：

1. `triggerTaskId` 必须等于当前 `currentTaskId`，或指向当前 `taskStates` 中 `status === "blocked_for_human"` 的任务，否则返回 400。
2. `reasonCategory === "g0_invalid"` 时，`triggerTaskId` 必须是 `phase === "calibration"` 的任务，或其上游存在 G0 校准任务，否则返回 400。
3. `rationale` 去除空白后必须非空。
4. 同一 workflow 同一时间只允许一个未完成的 amendment。若已存在未完成 amendment，再次调用 `revision-requests` 返回 409，并在响应中返回现有 amendment 路径。
5. manual_gate decision 为 `requires_replan` 时，与本接口共享 amendment 命名空间，默认 `reasonCategory = "manual_gate_dispute"`。

### 15.3 修订流程

```text
执行失败或人工要求重规划
  ↓
暂停 runner
  ↓
生成 task-plan-amendment-{N}.json
  ↓
触发后台 createTaskPlanStage，调用 Codex 生成 task-plan-v{N}-draft.json
  ↓
输入包含原设计稿、原任务计划、执行状态、失败证据和 task-plan-amendment-{N}.json
  ↓
走任务计划修订审查链路
  ├─ 超过 maxRevisionReviewRounds=3 或修订链路不可恢复失败 → failed / revision_failed
  ↓
输出 task-plan-v{N}.json 与 task-plan-review-v{N}-{round}.json
  ↓
本地门禁和 ClaudeCode 审查通过
  ↓
生成 execution-rebase-report-{N}.json
  ↓
迁移 execution-state.json 的 planVersion 和 taskStates
  ↓
清空 currentTaskId
  ↓
runner 从 task-plan-v{N}.json 继续执行
```

修订审查链路不能覆盖原 `task-plan.json`。需要新增 `runTaskPlanRevisionReviewLoop` 或等价参数化能力，使审查链路读取 `task-plan-amendment-{N}.json` 中的修订理由、原 `task-plan.json`、当前 `execution-state.json`、失败证据和 `task-plan-v{N}-draft.json`，输出 `task-plan-v{N}.json`。

修订链路最多执行 `maxRevisionReviewRounds = 3` 轮。超过最大轮次仍未通过，或 Codex／ClaudeCode 修订审查过程出现不可恢复错误时，job 进入 `failed`，错误类型为 `revision_failed`。

### 15.4 修订边界

1. 已完成任务原则上不可修改，只能追加补偿任务。
2. 未开始任务可以调整依赖、验收标准、角色、顺序和 `aoPrompt`。
3. 失败任务可以被替换为一个或多个 recovery task。
4. 如果设计稿本身错误，必须回到设计修订，不允许只改任务计划绕过设计问题。
5. 新计划必须重新通过 schema 校验、本地门禁和任务计划审查。
6. 所有旧计划、新计划、迁移报告都必须保留。

### 15.5 状态迁移规则

迁移时按 taskId 和语义映射执行：

1. 新计划仍保留且语义一致的已完成任务，继承 `completed`。
2. 新计划删除的已完成任务，记录为 `superseded`，不再参与新依赖图。
3. 新增任务从 `pending` 开始。
4. 失败任务若被替换，旧任务标记 `superseded`，新 recovery task 为 `pending`。
5. 正在执行任务必须先停止或人工裁决，不自动迁移为 completed。
6. 无法自动映射的任务必须进入人工确认列表。
7. 如果新计划中 taskId 与旧状态冲突，例如旧状态是 `superseded` 但新计划恢复为普通任务，必须进入人工确认，不允许自动迁移。
8. 人工确认后唯一合法操作是新建一个不同 taskId 的等价任务，不允许恢复原 taskId。这样保持 `superseded` 不可逆语义，避免旧状态被复活。
9. 迁移完成后必须将 `currentTaskId` 清空为 null，让 runner 在下一次 tick 根据新计划重新选择下一个任务。

## 16. Web API 设计

### 16.1 启动连续执行

```http
POST /api/ao/execution-jobs
```

请求：

```json
{
  "workflowId": "WF-20260630T031508Z",
  "projectRoot": "C:\\workspace\\fast-transport",
  "mode": "continuous",
  "dryRun": false
}
```

响应：

```json
{
  "jobId": "EXEC-20260704T100000Z",
  "workflowId": "WF-20260630T031508Z",
  "mode": "created",
  "status": "running",
  "currentTaskId": "TASK-001"
}
```

`mode` 可选值：

```text
created
resumed
```

启动规则：

1. `status === "idle"`：创建新 job，响应 `mode = "created"`。
2. `status === "stopped"` 且仍有未完成任务：不创建新 job，视为 resume 请求，响应 `mode = "resumed"`。服务端先将状态迁移回 `running`，再按 §16.4 的 resume 流程同步 AO session。
3. resume-on-stop 时如果同步 AO session 立即失败，响应仍返回 200 和 jobId，但 `status = "failed"`，并包含 `failure.kind = "ao_status_failed"`，让 UI 继续轮询和展示恢复动作。
4. `status === "completed"`：返回 409，提示任务已全部完成。
5. `status === "failed"`：返回 409，提示必须先选择 retry、mark-completed 或 revision-request。
6. `status === "paused_for_replan"`：返回 409，提示必须先完成或放弃修订流程。
7. `status === "waiting_manual_gate"`：返回 409，提示必须先做门禁决策。
8. `status === "running"`：返回 409，提示已有 active job。

这样避免 stopped 历史记录被重复创建为多个 job，也让 UI 能区分新建和恢复。

### 16.2 获取执行 job

```http
GET /api/ao/execution-jobs/:jobId
```

响应：

```json
{
  "jobId": "EXEC-20260704T100000Z",
  "workflowId": "WF-20260630T031508Z",
  "status": "running",
  "currentTaskId": "TASK-001",
  "summary": {
    "completed": 0,
    "working": 1,
    "pending": 104,
    "blocked": 0
  },
  "logs": []
}
```

`currentTaskId` 在 `paused_for_replan → running` 完成状态迁移后可能短暂为 null。此时 UI 应显示“等待调度器选择下一个任务”，下一次 runner tick 会根据新计划重新计算。

### 16.3 停止执行

```http
POST /api/ao/execution-jobs/:jobId/stop
```

行为：

1. 停止调度器继续派发新任务。
2. 不强杀已运行 AO session。
3. job 状态变为 `stopped`。
4. 写入 `execution-state.json.status = "stopped"`，供重启后识别。

### 16.4 继续执行

```http
POST /api/ao/execution-jobs/:jobId/resume
```

行为：

1. 读取当前 `execution-state.json`。
2. 先执行 `syncWorkingTasksWithAo`。
3. 如果 stop 期间 working 任务已失败，直接进入 failed 处理流程。
4. 如果 working 任务仍运行，恢复轮询。
5. 如果没有 working 任务，从可继续的位置恢复。

resume 是把 `stopped` 状态迁移回 `running` 的唯一入口。Web 进程重启不会自动 resume stopped 状态。

### 16.5 重试任务

```http
POST /api/ao/execution-jobs/:jobId/tasks/:taskId/retry
```

请求：

```json
{}
```

响应规则：

1. 当前任务不存在或不是可重试状态，返回 400。
2. attempt 超过 `maxAttempts`，返回 400。
3. 状态写入成功并重新派发后返回 200。

### 16.6 人工确认任务完成

```http
POST /api/ao/execution-jobs/:jobId/tasks/:taskId/mark-completed
```

请求：

```json
{
  "rationale": "人工检查产物和验收标准后确认该任务已完成。"
}
```

`rationale` 必填，去除空白后长度必须大于 0。

### 16.7 manual_gate 决策

```http
POST /api/ao/execution-jobs/:jobId/manual-gates/:taskId/decision
```

请求：

```json
{
  "decision": "approved",
  "rationale": "人工确认门禁证据满足放行条件。"
}
```

`decision` 可选值：

```text
approved
requires_replan
blocked
```

重复提交规则按 §13 执行。

当 `decision === "requires_replan"` 时，服务端必须按 §15.2 创建或复用 amendment。若已有未完成 amendment，返回 409 并指向现有 amendment；否则使用 `reasonCategory = "manual_gate_dispute"` 生成修订请求。

### 16.8 创建计划修订请求

```http
POST /api/ao/execution-jobs/:jobId/revision-requests
```

请求体按 §15.2 执行。

## 17. CLI 设计

CLI 是备用入口，主要用于排障、自动化和测试，不作为普通用户处理门禁的默认方式。

CLI 命令默认直接驱动 runner，并通过 `.ao-control-plane/<workflowId>/execution.lock` 与 Web runner 互斥。如果 Web 服务中已有同 workflow 的 active job，CLI 默认拒绝启动；使用 `--attach` 只观察日志和状态，不驱动 runner。

保留现有 `execute-plan` 单轮派发能力，新增连续执行命令：

```text
ao-control-plane execute-plan-continuous <task-plan-file>
  --project-root <path>
  --artifact-root <path>
  --workflow-id <id>
  --poll-interval-ms <number>
  --stale-lock-ms <number>
  --dry-run
  --attach
```

辅助命令：

```text
ao-control-plane execution-status --workflow-id <id> --artifact-root <path>
ao-control-plane execution-resume --workflow-id <id> --artifact-root <path>
ao-control-plane execution-stop --workflow-id <id> --artifact-root <path>
ao-control-plane execution-retry --workflow-id <id> --task-id <taskId>
ao-control-plane execution-mark-completed --workflow-id <id> --task-id <taskId> --rationale <text>
ao-control-plane execution-release-gate --workflow-id <id> --task-id <taskId> --decision approved
```

计划文件解析规则：

1. 显式传入 `<task-plan-file>` 时，以该文件为准。
2. 基于 `workflowId + artifactRoot` 的命令必须先读取 `execution-state.json.planVersion`，再解析当前生效计划文件。
3. 当 `planVersion !== "task-plan-current"` 时，workflow scoped 命令必须读取 `task-plan-v{N}.json`，不能回退读取 `task-plan.json`。

## 18. UI 设计

“AO 执行”页展示：

1. 当前执行模式：单轮派发／连续执行。
2. 当前 job 状态。
3. 当前任务 ID、标题、角色、attempt、AO session。
4. 任务统计：completed、working、pending、blocked、superseded。
5. 最近执行日志。
6. 当前中断原因。
7. 可执行操作。

按钮：

1. “启动连续执行”。
2. “停止执行”。
3. “继续执行”。
4. “重试当前任务”。
5. “人工确认完成并继续”。
6. “放行门禁”。
7. “要求重规划”。
8. “标记阻断”。

门禁暂停时，UI 进入专门的“门禁决策”视图：

1. 顶部显示“执行已暂停，等待人工门禁决策”。
2. 中间显示门禁任务和上游完成证据。
3. 左侧展示验收标准检查清单。
4. 右侧展示关键产物路径、AO session 和执行日志摘要。
5. 底部提供三个决策按钮：“放行并继续”“要求重规划”“标记阻断”。
6. 用户点击后由前端提交结构化 JSON，用户不需要手写命令或 JSON。

失败时，页面不应只显示 JSON。应明确提示：

```text
TASK-017 执行失败，连续执行已暂停。
请选择：重试当前任务、人工确认完成并继续、要求修复任务计划。
```

URL 状态设计：

```text
?workflowId=WF-x&jobId=EXEC-x&view=progress
?workflowId=WF-x&jobId=EXEC-x&view=manual-gate&taskId=TASK-002
?workflowId=WF-x&jobId=EXEC-x&view=failure&taskId=TASK-017
```

页面刷新或多标签页打开时，UI 根据 URL 恢复对应视图。

## 19. 安全与审计

### 19.1 禁止自动绕过门禁

`manual_gate` 必须由用户决策。调度器不得根据 AO 输出或任务文本自动放行。

### 19.2 禁止隐式跳过任务

任务失败后不提供普通“跳过”按钮。若必须跳过，应作为高级人工操作，要求理由，并写入审计日志。

### 19.3 禁止模型选择字段

任务派发继续只允许 `aoRole`。调度器必须继续拒绝以下字段：

```text
agent
model
provider
codex
claudeCode
```

### 19.4 原始计划不可覆盖

原 `task-plan.json` 是批准基线，不应被执行状态污染。修订时生成新版本。

### 19.5 每一步写日志

`execution-log.jsonl` 每行记录一个事件。所有日志事件统一包含：

1. `type`
2. `taskId`
3. `attempt`
4. `actor`
5. `at`
6. 事件相关字段

示例：

```json
{"type":"task_dispatched","taskId":"TASK-001","attempt":1,"actor":"runner","aoSessionId":"SESSION-abc","at":"2026-07-04T10:00:00.000Z"}
{"type":"task_completed","taskId":"TASK-001","attempt":1,"actor":"runner","at":"2026-07-04T10:10:00.000Z"}
{"type":"manual_gate_waiting","taskId":"TASK-002","attempt":0,"actor":"runner","at":"2026-07-04T10:10:01.000Z"}
{"type":"manual_gate_decided","taskId":"TASK-002","attempt":0,"actor":"user","decision":"approved","at":"2026-07-04T10:12:00.000Z"}
```

## 20. 错误分类

统一错误类型以 §9 的 `ExecutionErrorKind` 为准。

错误处理原则：

| kind | Job 状态 | 处理 |
| --- | --- | --- |
| `ao_spawn_failed` | `failed` | spawn 命令直接失败，立即中断 |
| `ao_status_failed` | `failed` | AO 状态查询超过重试阈值 |
| `ao_task_failed` | `failed` | AO session 失败状态经过确认窗口 |
| `ao_task_stuck` | `failed` | AO session stuck 状态经过确认窗口 |
| `ao_task_needs_input` | `failed` | AO session needs_input 状态经过确认窗口 |
| `manual_gate_blocked` | `failed` | 用户标记门禁阻断 |
| `manual_gate_requires_replan` | `paused_for_replan` | 用户要求重规划 |
| `revision_requested` | `paused_for_replan` | 用户从失败面板或独立入口要求修订计划 |
| `revision_failed` | `failed` | 修订审查链路超过最大轮次或不可恢复失败 |
| `dependency_deadlock` | `failed` | 无 working、无 ready、也无可解释门禁等待 |
| `plan_missing` | `failed` | `planVersion` 指向的计划文件不存在 |
| `plan_invalid` | `failed` | 当前生效计划解析或 schema 校验失败 |
| `state_corrupted` | `failed` | `execution-state.json` 损坏或不可迁移 |
| `dispatcher_stopped` | `stopped` | 用户停止调度器 |

## 21. 与现有任务审查链路的关系

任务计划生成阶段仍然由 Codex 生成任务计划、ClaudeCode 审查、本地门禁校验。

连续执行阶段不再调用 Codex 或 ClaudeCode 做派发决策。代码调度器已经可以根据任务计划、执行状态和 AO session 状态完成本需求的调度闭环。

只有当用户选择“要求修复计划”时，才重新进入任务计划修订链路。修订链路读取：

1. 原设计稿。
2. 原任务计划。
3. 任务计划审查记录。
4. `execution-state.json`。
5. `execution-log.jsonl`。
6. 失败任务 AO session 摘要。
7. `task-plan-amendment-{N}.json`。

修订链路输出 `task-plan-v{N}.json` 与 `task-plan-review-v{N}-{round}.json`，不覆盖原 `task-plan.json`。

## 22. 测试方案

### 22.1 单元测试

新增测试文件：

```text
src/workflow/continuous-plan-execution.test.ts
src/workflow/execution-state-store.test.ts
src/workflow/task-readiness.test.ts
src/web/execution-jobs.test.ts
```

覆盖场景：

1. 串行派发第一个 ready 任务。
2. 第一个任务 completed 后派发下一个任务。
3. 依赖未完成时不派发。
4. `any_completed` 至少一个依赖完成后派发。
5. `manual_gate` 未放行时暂停。
6. G0 校准任务未完成时，manual_gate 仍为 `waiting_dependencies`。
7. `manual_gate` approved 后继续。
8. `manual_gate` requires_replan 后进入 `paused_for_replan`。
9. AO failed 第一次观测不失败，第二次连续观测且间隔满足阈值后 job failed。
10. `statusObservations` 每次 sync 后追加 attempt，并裁剪到最近 5 条。
11. retry 后 observation 按新 attempt 重新计算失败确认窗口。
12. runner 重启后第一次观测到 failure 状态不直接失败。
13. pendingDispatch 崩溃恢复时能匹配孤儿 AO session。
14. pendingDispatch 崩溃恢复找不到 session 时清空 pendingDispatch 并允许重新派发。
15. pendingDispatch 崩溃恢复发现多个候选 session 时进入 `state_corrupted`。
16. AO status 查询失败重试，超过阈值后 failed。
17. retry 当前任务会增加 attempt 并重新 spawn。
18. retry 超过 `maxAttempts` 返回 400。
19. 人工 mark completed 后继续派发后续任务，并记录 `markedCompletedBy`。
20. 进程重启后从 `execution-state.json` 恢复，`stopped` 只恢复为只读历史记录。
21. 已 completed 任务不会重复派发。
22. working 且已有 `aoSessionId` 的任务不会重复 spawn。
23. dependency deadlock 会失败并输出可解释原因。
24. `execution-state.json` 解析失败或部分写入时进入 `state_corrupted`。
25. `planVersion` 指向的文件不存在时进入 `plan_missing`。
26. `task-plan-v{N}.json` 与旧状态迁移冲突时进入人工确认。
27. 旧状态为 `superseded` 的 taskId 在新计划中被恢复时，要求新建不同 taskId。
28. 修订迁移完成后清空 `currentTaskId`。
29. `revision-requests` 的 `triggerTaskId` 非当前或非 blocked task 时返回 400。
30. `reasonCategory === "g0_invalid"` 与非 G0 任务组合时返回 400。
31. 同一 workflow 已有未完成 amendment 时再次请求修订返回 409。
32. 修订审查超过 `maxRevisionReviewRounds` 后进入 `revision_failed`。
33. Web 持锁时 CLI `execute-plan-continuous` 拒绝启动。
34. CLI 持锁时 Web `POST /api/ao/execution-jobs` 返回 409。
35. 使用 `AO_CONTROL_PLANE_STALE_LOCK_MS=1000` 验证陈旧锁覆盖；未超阈值时拒绝。
36. `POST /api/ao/execution-jobs` 对 `idle` 返回 `mode = "created"`，对 `stopped` 返回 `mode = "resumed"`。
37. `POST /api/ao/execution-jobs` 对 completed、failed、paused_for_replan、waiting_manual_gate、running 返回 409。

### 22.2 集成测试

使用 fake AO adapter：

1. 模拟 session 从 `running` 变为 `completed`。
2. 模拟 session 从 `running` 变为 `failed`。
3. 模拟 `needs_input`。
4. 模拟 `ao session ls` 临时失败后恢复。
5. 模拟 Web 进程重启后扫描 `execution-state.json` 重建 job。

### 22.3 Web 测试

覆盖：

1. 点击“启动连续执行”创建 job。
2. UI 轮询 job 状态。
3. 失败后显示三个恢复动作。
4. 门禁暂停后显示门禁决策按钮。
5. G0 门禁显示 G0 校准产物分区，非 G0 门禁不显示 G0 专属产物。
6. stop 后不再派发新任务。
7. resume 后先同步 AO session。
8. URL query 可恢复 progress、manual-gate 和 failure 视图。

## 23. 本次交付范围

本次不按阶段拆分，也不把恢复、门禁和计划修订留到后续。本次需要一次性实现完整连续任务调度闭环。可以按以下顺序开发和验收，但每一项都属于本次交付范围。

1. 新增 `execution-state.json`、`execution-log.jsonl`、`execution.lock`、`task-plan-amendment-*.json`、`task-plan-v{N}.json`、`task-plan-review-v{N}-{round}.json` 和 `execution-rebase-report-*.json` 的读写能力，所有修订产物必须 tmp + atomic rename。
2. 新增 `ExecutionStateStore`，实现单例、写入队列、原子写入、日志互斥追加、损坏状态处理和 planVersion 白名单校验。
3. 从 `plan-execution.ts` 抽出 `task-readiness.ts` 纯函数。
4. 新增 `ContinuousExecutionRunner`，实现严格串行调度。
5. 实现基于当前生效任务计划和 `execution-state.json` 的 readiness 判断。
6. 实现 AO 派发，继续使用 `ao spawn --role <aoRole> --prompt <aoPrompt>`。
7. 实现 AO session 轮询、按 attempt 隔离的状态观察窗口、`statusObservations` 裁剪、查询重试和状态映射。
8. 实现任务完成后自动继续派发下一个可执行任务。
9. 实现任务确认失败、卡住、需要输入时中断执行。
10. 实现 Web 进程重启扫描 `execution-state.json` 重建 execution job，其中 `stopped` 只重建为只读历史记录，`pendingDispatch` 必须先做孤儿 session 恢复。
11. 实现 stop 和 resume，resume 必须先同步 AO session，且是 stopped 恢复为 running 的唯一入口。
12. 实现 retry 当前任务和 `maxAttempts` 限制。
13. 实现人工确认任务完成并继续。
14. 实现 `manual_gate` 暂停。
15. 实现 Web 门禁决策面板，支持“放行并继续”“要求重规划”“标记阻断”。
16. 实现门禁检查清单、关键产物路径展示、G0 自适应证据分区、二次确认和结构化决策提交。
17. 实现计划修订请求生成接口，包括 triggerTaskId 校验、G0 reason 校验、rationale 非空校验和 amendment 去重。
18. 实现 `task-plan-v{N}.json` 修订入口和任务计划修订审查链路，包含 `task-plan-v{N}-draft.json`、`maxRevisionReviewRounds = 3` 和 `revision_failed`。
19. 实现 `execution-rebase-report-*.json`，将旧执行状态迁移到新计划，迁移完成后清空 `currentTaskId`。
20. 实现 Web execution job 管理，包括启动、查看、停止、继续、重试、人工确认完成、门禁决策和修订请求，启动响应必须区分 `mode = "created"` 与 `mode = "resumed"`。
21. 实现 CLI 备用命令、`execution.lock` 互斥、锁内容 schema、陈旧锁判定、`AO_CONTROL_PLANE_STALE_LOCK_MS`、`--stale-lock-ms` 和 `--attach` 观察模式。
22. 实现单元测试、集成测试和 Web 测试。
23. 更新 UI 文案，将“派发执行”明确为“启动连续执行”，避免用户误解为单轮派发。

本次明确不实现并发调度。连续执行必须是单任务串行推进。

## 24. 推荐实现结构

建议新增：

```text
src/workflow/continuous-plan-execution.ts
src/workflow/execution-state-store.ts
src/workflow/execution-log.ts
src/workflow/task-readiness.ts
src/workflow/task-plan-revision-review-loop.ts
src/web/execution-jobs.ts
```

建议保留：

```text
src/workflow/plan-execution.ts
```

`plan-execution.ts` 继续负责单轮派发，便于兼容 CLI 和现有测试。它不再拥有独立 readiness 真相，而是复用 `task-readiness.ts`。

`continuous-plan-execution.ts` 负责循环调度，内部必须从 `ExecutionStateStore` 读取 runtime 状态，不能直接依赖一次性派发返回值作为状态来源。

## 25. 样本流程

以 `WF-20260630T031508Z` 为例：

1. 用户点击“启动连续执行”。
2. runner 读取 `execution-state.json` 和当前生效计划，发现 `TASK-001` 无依赖且 runtime pending。
3. runner 派发 `TASK-001` 给 AO `architect`。
4. runner 轮询 AO session。
5. `TASK-001` completed。
6. runner 扫描下一个任务，发现 `TASK-002` 是 `manual_gate`，且依赖已完成。
7. runner 进入 `waiting_manual_gate`。
8. UI 展示 G0 门禁决策面板，用户勾选检查项后点击“放行并继续”。
9. runner 继续执行。
10. 后续按依赖顺序持续推进。
11. 若某 implementation 任务失败并经过确认窗口，runner 停止，UI 提供重试、人工确认完成、要求修复计划。
12. 若用户选择修复计划，则进入 `paused_for_replan`，生成 `task-plan-amendment-{N}.json`。
13. 修订链路输出 `task-plan-v{N}.json`，生成 `execution-rebase-report-{N}.json`。
14. runner 从新计划继续执行。

## 26. 审查建议处理边界

第 1 轮、第 2 轮和第 3 轮审查报告中的 blocking、major 和 minor 建议均已吸收到本文档，只有一项不按原建议形式采纳：第 1 轮审查报告建议按 10 个 PR 分阶段推进。该建议不写入设计方案的交付模型，因为用户明确要求“不考虑分段想法，直接指出本次要做到的情况”。本文保留开发和验收排序，但所有条目都属于本次交付范围，不作为后续阶段或可选项。

## 27. 结论

连续任务调度器应作为确定性的流程控制器实现，而不是引入额外 agent 代替调度决策。结合当前项目结构，本需求的调度闭环可以完全由代码完成：按批准后的任务计划、执行状态和 AO session 状态持续推进任务；遇到失败或人工门禁时暂停；需要修复计划时进入版本化修订流程。

最终模型可以概括为：

```text
task-plan.json / task-plan-v{N}.json 是执行基线
execution-state.json 是运行账本和断点续跑真相源
execution-log.jsonl 是审计记录
runner 按依赖和顺序连续执行
失败后先重试或人工确认
计划错误时生成 task-plan-v{N}.json 并迁移状态
```
