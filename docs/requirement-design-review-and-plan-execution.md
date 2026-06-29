# 需求设计审查层与结构化计划执行层设计文档

## 1. 背景

当前 AO 负责多 agent 编排、worker session 管理、独立 worktree、PR、CI、review 状态跟踪和 Dashboard 展示。上层软件负责在 AO 之前完成需求分析、设计审查、整改循环、任务拆解和计划状态管理。

本阶段不修改 AO。上层软件通过 `ao spawn --role <role> --prompt <text>` 创建 AO worker，并在 prompt 中携带 `workflowId` 与 `taskId`，让 AO 看板可以看到任务归属。

一个重要约束是：需求进入执行层后，上层软件只能调用 AO 内置 worker role，不能在任务下发时指定 Codex、ClaudeCode 或其他具体 agent。具体 agent 的选择由 AO 项目的 `agent-orchestrator.yaml` 通过 worker role 配置决定。

## 2. 目标

- 用户提交需求后，由 Codex 完成需求分析和设计。
- ClaudeCode 对需求分析和设计进行审查，输出审查意见。
- Codex 根据审查意见整改，并说明不整改项及理由。
- 设计审查与整改循环执行，直到 ClaudeCode 给出“可进入任务拆解”的结论，或达到轮次上限后交由人工复核。
- 设计通过后，由 ClaudeCode 拆解结构化任务列表。
- 上层软件根据任务列表调用 AO 内置角色创建 worker session。
- AO 负责后续开发、测试、审核、PR、CI、review、状态和看板展示。
- 上层软件持续汇总 AO 状态，直到所有任务完成或进入人工复核。

## 3. 非目标

- 本阶段不修改 AO core、CLI、Dashboard。
- 本阶段不要求 AO 原生理解 workflow 或 task。
- 本阶段不在 AO 执行任务时显式指定 Codex、ClaudeCode 或具体 agent。
- 本阶段不让 AO orchestrator agent 承担完整项目计划调度。
- 本阶段不实现复杂项目管理系统，只实现需求到执行计划的闭环控制。

## 4. Agent 分工

### 4.1 需求治理层

需求治理层由上层软件直接控制，可以明确选择 Codex 和 ClaudeCode。

| 阶段 | Agent | 职责 |
|---|---|---|
| 需求分析与设计 | Codex | 理解需求、分析代码上下文、输出方案、整改设计 |
| 设计审查 | ClaudeCode | 审查需求理解、设计风险、遗漏场景、可测试性 |
| 设计整改 | Codex | 根据审查意见修改设计，并说明不整改项 |
| 任务拆解 | ClaudeCode | 输出结构化任务列表、依赖、角色、验收标准 |
| 总控状态机 | 上层软件 | 管理 workflow、轮次、状态、人工复核点 |

### 4.2 AO 执行层

进入 AO 执行层后，上层软件不再指定具体 agent，只指定 AO 内置 worker role。

AO 当前内置角色包括：

| AO 角色 | 用途 |
|---|---|
| `architect` | 架构设计、边界划分、技术取舍和实施计划 |
| `ui-designer` | 用户流程、页面、交互状态和视觉方向 |
| `frontend-senior` | 复杂前端逻辑、跨组件状态和疑难问题 |
| `frontend-junior` | 低风险前端 CRUD、字段、文案和重复组件 |
| `backend-senior` | 复杂后端逻辑、状态机、核心契约和插件边界 |
| `backend-junior` | 低风险后端 CRUD、字段透传和简单测试 |
| `frontend` | 兼容型前端角色；当任务难度无法判断时兜底使用 |
| `backend` | 兼容型后端角色；当任务难度无法判断时兜底使用 |
| `reviewer` | 代码审查、风险识别、测试缺口和可维护性建议 |
| `qa` | 功能验证、回归测试、端到端路径检查和证据收集 |
| `docs` | 开发文档、配置参考、示例和发布说明 |
| `second-opinion` | 对复杂问题、风险方案和根因推断做独立复核 |

执行层任务只能包含 `aoRole`，不能包含 `agent`、`model`、`codex`、`claude-code` 等字段。若需要调整某个角色背后的 agent，应在 AO 配置文件中完成，而不是由上层软件在任务执行时指定。

任务拆解时应优先选择细分角色：

- 前端复杂任务优先使用 `frontend-senior`。
- 前端低风险、重复性或表单类任务优先使用 `frontend-junior`。
- 后端复杂任务优先使用 `backend-senior`。
- 后端低风险、字段透传或简单 CRUD 任务优先使用 `backend-junior`。
- `frontend` 和 `backend` 只作为兼容兜底角色，避免在任务难度明确时使用。

## 5. 总体架构

```text
用户需求
  ↓
上层软件：创建 workflow
  ↓
Codex：需求分析与设计
  ↓
ClaudeCode：设计审查
  ↓
Codex：整改与不整改说明
  ↓
循环直到通过或达到轮次上限
  ↓
ClaudeCode：结构化任务拆解，只输出 AO 内置角色
  ↓
上层软件：调用 AO 创建 worker session
  ↓
AO：按内置角色执行、PR、CI、review、看板
  ↓
上层软件：汇总任务状态
  ↓
完成或人工复核
```

## 6. 核心模块

### 6.1 Workflow Manager

负责创建和维护需求级工作流。

状态包括：

- `draft`：需求已创建，尚未开始分析。
- `designing`：Codex 正在分析和设计。
- `design_reviewing`：ClaudeCode 正在审查设计。
- `design_revising`：Codex 正在整改设计。
- `ready_for_planning`：设计已通过，可进入任务拆解。
- `planning`：ClaudeCode 正在拆解任务。
- `executing`：任务已下发 AO。
- `blocked_for_human`：达到轮次上限或出现人工决策点。
- `completed`：所有任务完成。
- `failed`：流程失败，需人工处理。

### 6.2 Design Review Loop

负责设计审查循环。

默认流程：

1. Codex 输出设计稿。
2. ClaudeCode 输出审查结论。
3. 若结论为 `approved`，进入任务拆解。
4. 若结论为 `changes_requested`，Codex 整改。
5. Codex 必须逐条说明已整改项、未整改项、未整改理由、风险与替代方案。
6. 超过 `maxDesignReviewRounds` 后，进入人工复核。

ClaudeCode 审查结论必须是以下之一：

- `approved`：设计可进入任务拆解。
- `changes_requested`：设计需要 Codex 整改。
- `human_review_required`：存在无法自动决策的问题，需要人工复核。

`maxDesignReviewRounds` 计算 ClaudeCode 审查次数，不计算 Codex 初稿生成次数，也不单独计算 Codex 整改次数。达到上限时，如果最后一次 ClaudeCode 审查仍未给出 `approved`，workflow 进入 `blocked_for_human`，不再自动要求 Codex 继续整改。

示例时序：

```text
design-v1 -> review#1 -> changes_requested -> design-v2 -> review#2 -> approved
design-v1 -> review#1 -> changes_requested -> design-v2 -> review#2 -> changes_requested -> design-v3 -> review#3 -> human
```

ClaudeCode 对每条 finding 必须给出状态：

- `addressed`：Codex 已整改，ClaudeCode 接受。
- `accepted_as_is`：Codex 未整改，但理由、风险说明或替代方案被 ClaudeCode 接受。
- `unresolved`：未整改或整改不足，ClaudeCode 不接受。

当所有 findings 都进入 `addressed` 或 `accepted_as_is` 时，ClaudeCode 必须给出 `approved`。只要存在 `unresolved`，ClaudeCode 必须给出 `changes_requested` 或 `human_review_required`。

Codex 设计稿必须使用稳定结构，至少包含：

- 背景与问题定义。
- 目标与非目标。
- 影响范围。
- 方案概述。
- 接口、数据或关键契约变化。
- 任务拆解前置约束。
- 风险、回滚方案和替代方案。
- 可测试性自评。

ClaudeCode 只审查满足上述结构的设计稿。若设计稿结构缺失，上层软件应要求 Codex 先补齐结构，而不是进入正式审查轮次。

### 6.3 Task Planner

由 ClaudeCode 根据最终设计稿生成结构化任务列表。

任务列表必须只使用 AO 内置角色。任务中禁止出现具体 agent 名称。

每个任务包含：

- `taskId`
- `workflowId`
- `title`
- `description`
- `type`
- `dependencies`
- `dependencyCondition`
- `aoRole`
- `acceptanceCriteria`
- `aoPrompt`
- `status`

`type` 取值必须属于以下枚举：

| type | 用途 | 推荐 AO 角色 |
|---|---|---|
| `implementation` | 功能实现 | `frontend-senior`、`frontend-junior`、`backend-senior`、`backend-junior` |
| `test` | 测试补充或测试修复 | `qa`、`backend-junior`、`frontend-junior` |
| `refactor` | 保持行为不变的结构调整 | `frontend-senior`、`backend-senior` |
| `design` | 执行层内的小范围设计澄清 | `architect`、`ui-designer` |
| `review` | 代码审查或方案复核 | `reviewer`、`second-opinion` |
| `docs` | 文档、示例、说明更新 | `docs` |
| `verification` | 功能验收、回归验证、证据收集 | `qa` |

`dependencyCondition` 取值必须属于以下枚举：

- `all_completed`：默认值，所有依赖任务完成后才可执行。
- `any_completed`：任一依赖任务完成后即可执行。
- `manual_gate`：依赖任务完成后仍需人工确认才可执行。

示例：

```json
{
  "taskId": "TASK-003",
  "workflowId": "WF-001",
  "title": "实现权限 API",
  "type": "implementation",
  "dependencies": [],
  "dependencyCondition": "all_completed",
  "aoRole": "backend-senior",
  "acceptanceCriteria": [
    "接口按角色校验权限",
    "新增覆盖成功、拒绝、未登录三类测试",
    "现有权限相关测试保持通过"
  ],
  "aoPrompt": "[WF-001 / TASK-003] 实现权限 API。请按验收标准完成实现、测试和 PR。",
  "status": "pending"
}
```

非法示例：

```json
{
  "taskId": "TASK-003",
  "agent": "codex",
  "model": "gpt-5-codex",
  "aoRole": "backend-senior"
}
```

非法原因：进入执行层后，上层软件只能指定 `aoRole`，不能指定具体 agent 或 model。

### 6.4 AO Dispatcher

负责把结构化任务转换成 AO spawn 命令。

本阶段不使用 AO 原生 metadata，而是在 prompt 中加入任务标识。上层软件始终使用 `--prompt` 模式，不向 AO 下发 issue 编号：

```bash
ao spawn --role backend-senior --prompt "[WF-001 / TASK-003] 实现权限 API。请按验收标准完成实现、测试和 PR。"
```

多项目场景下，AO Dispatcher 必须在调用 `ao spawn` 前确保项目解析明确。当前 `ao spawn` 不提供 `--project` 参数，因此只允许以下方式之一：

- 在目标项目路径下执行 `ao spawn`，让 AO 通过当前工作目录解析项目。
- 在 AO session 环境内执行，并依赖 `AO_PROJECT_ID`。
- 当前 AO 配置只有一个项目。

如果无法唯一解析目标项目，AO Dispatcher 必须失败并要求人工指定执行项目，不能盲目调用 `ao spawn`。

推荐 prompt 格式：

```text
[WF-001 / TASK-003]
任务名称：实现权限 API
所属需求：用户权限管理
AO 角色：backend-senior
验收标准：
1. 接口按角色校验权限。
2. 新增覆盖成功、拒绝、未登录三类测试。
3. 现有权限相关测试保持通过。
上下文摘要：
最终设计稿中已确定采用现有 auth middleware 扩展角色校验，不新增独立权限服务。
注意事项：
保持现有 API 响应格式，不改动无关模块。
```

AO Dispatcher 必须校验：

- `aoRole` 必须属于 AO 内置角色列表。
- 不允许任务包含 `agent`、`model`、`provider` 等执行 agent 字段。
- AO 本身允许 `ao spawn --agent` 覆盖 agent，因此禁止行为必须由 AO Dispatcher 在生成命令前做静态校验和拦截，不能依赖 AO 报错。
- AO Dispatcher 生成的命令不允许包含 `--agent`。
- 不允许在 prompt 中要求 worker 切换具体 agent。

### 6.5 AO Status Collector

负责定期读取 AO 状态。

上层软件统一使用以下命令作为 session 状态来源，不解析普通 CLI 文本：

```bash
ao session ls --json --include-terminated
```

必要时追加 `--project <id>` 过滤项目：

```bash
ao session ls --json --include-terminated --project <projectId>
```

注意：`ao session ls` 支持 `-p/--project`，但 `ao spawn` 当前不支持 `--project`。AO Dispatcher 必须区分两者的项目解析方式，不能把 status collector 的 `--project` 用法套用到 spawn 命令上。

上层软件维护 `taskId -> aoSessionId` 映射。映射建立采用以下策略：

1. AO Dispatcher 执行 `ao spawn --role <role> --prompt "[WF / TASK] ..."`。
2. 读取 `ao spawn` 标准输出中的 `SESSION=<sessionId>`。
3. 若未成功读取 sessionId，则重试调用 `ao session ls --json --include-terminated`，查找最近创建且 prompt 前缀、分支或 display name 能关联到 `[WF / TASK]` 的 session。
4. 重试策略默认为每 5 秒一次，最多 6 次。
5. 若仍无法建立映射，任务进入 `blocked_for_human`，需要人工绑定 session。

当前 `ao session ls --json` 的 `role` 字段只区分 `worker` 与 `orchestrator`，不保证暴露具体 `workerRole`。上层软件不得依赖 session JSON 中存在 `workerRole` 字段；需要按角色过滤时，应使用自身任务表中的 `aoRole -> aoSessionId` 映射。

## 7. AO 使用方式

AO 作为执行引擎使用。上层软件只下发角色，不下发具体 agent。

示例 AO 配置可以在 AO 项目内决定每个角色背后的 agent：

```yaml
defaults:
  orchestrator:
    agent: claude-code
  worker:
    agent: codex

workerRoles:
  frontend-senior:
    agent: codex
  backend-senior:
    agent: codex
  frontend-junior:
    agent: opencode
  backend-junior:
    agent: reasonix
  frontend:
    agent: codex
  backend:
    agent: codex
  qa:
    agent: opencode
  reviewer:
    agent: claude-code
  docs:
    agent: opencode
```

上层软件不直接读取或依赖上述 agent 配置。上层软件只生成如下命令：

```bash
ao spawn --role frontend-senior --prompt "[WF-001 / TASK-004] 实现权限管理页面。..."
ao spawn --role backend-senior --prompt "[WF-001 / TASK-003] 实现权限 API。..."
ao spawn --role qa --prompt "[WF-001 / TASK-008] 验证权限管理完整流程。..."
ao spawn --role reviewer --prompt "[WF-001 / TASK-009] 审查权限管理相关 PR。..."
```

禁止生成如下命令：

```bash
ao spawn --agent codex --role backend-senior --prompt "[WF-001 / TASK-003] 实现权限 API。..."
ao spawn --agent claude-code --role reviewer --prompt "[WF-001 / TASK-009] 审查权限管理相关 PR。..."
```

AO Dashboard 可以看到所有 worker session、角色、状态、终端输出、PR、CI 和 review 状态。任务归属通过 prompt 前缀 `[WF-001 / TASK-003]` 识别。

## 8. 数据模型

### 8.1 Workflow

```json
{
  "workflowId": "WF-001",
  "title": "用户权限管理",
  "rawRequirement": "为系统增加用户权限管理能力。",
  "status": "executing",
  "designRounds": 2,
  "maxDesignReviewRounds": 3,
  "approvedDesignVersion": "design-v3",
  "tasks": ["TASK-001", "TASK-002", "TASK-003"]
}
```

### 8.2 Design Review Round

```json
{
  "workflowId": "WF-001",
  "round": 2,
  "designer": "codex",
  "reviewer": "claude-code",
  "designVersion": "design-v2",
  "reviewDecision": "changes_requested",
  "findings": [
    {
      "id": "DRF-001",
      "title": "缺少未登录场景",
      "body": "设计稿覆盖了角色不足，但没有覆盖未登录用户访问权限 API 的行为。",
      "severity": "warning",
      "status": "addressed"
    }
  ]
}
```

### 8.3 Task

```json
{
  "taskId": "TASK-003",
  "workflowId": "WF-001",
  "title": "实现权限 API",
  "type": "implementation",
  "aoRole": "backend-senior",
  "dependencies": [],
  "dependencyCondition": "all_completed",
  "aoSessionId": "app-3",
  "status": "working",
  "acceptanceCriteria": [
    "接口按角色校验权限",
    "新增覆盖成功、拒绝、未登录三类测试"
  ]
}
```

## 9. 执行策略

- 无依赖任务可以并行下发 AO。
- 有依赖任务必须按 `dependencyCondition` 判断是否可执行，默认要求所有依赖任务进入 `completed`。
- 上层软件只使用 `aoRole` 决定 AO worker role。
- 具体 agent 由 AO 配置解析，上层软件不关心也不覆盖。
- 开发任务完成后，可创建 `qa` 或 `reviewer` 角色任务。
- 默认升级阈值：CI 失败次数大于或等于 3 次、`stuck` 持续大于或等于 30 分钟、`needs_input` 持续大于或等于 10 分钟时，上层软件将任务标记为 `blocked_for_human`。这些阈值允许 workflow 级配置覆盖。
- 所有任务完成后，workflow 进入 `completed`。
- 任一关键任务失败且无法恢复，workflow 进入 `blocked_for_human`。

## 10. 人工复核条件

- 设计审查达到轮次上限仍未通过。
- Codex 对 ClaudeCode 的审查意见给出“不整改”，且 ClaudeCode 不接受理由。
- ClaudeCode 在任务拆解阶段无法将任务映射到 AO 内置角色。
- 任务依赖冲突无法自动解决。
- 任务 `dependencyCondition` 为 `manual_gate`，且其依赖任务完成后等待人工放行。
- AO worker 长时间 stuck。
- CI 多次失败且 reviewer 或 qa 无法定位。
- 多个 worker 修改冲突严重。
- reviewer 任务执行 3 轮后仍然给出 `changes_requested`，或最终 reviewer 未给出可合并结论。

## 11. 看板可见性

本阶段不修改 AO 看板，因此 AO 看板展示的是 session 维度，而不是 workflow 维度。

可见内容包括：

- 每个 AO worker session。
- 使用的 AO role，例如 `frontend-senior`、`backend-senior`、`frontend-junior`、`backend-junior`、`qa`、`reviewer`。
- session 状态，例如 `working`、`idle`、`needs_input`、`stuck`、`pr_open`、`ci_failed`、`review_pending`、`mergeable`。
- 终端输出和 agent 执行过程。
- PR 链接、CI 状态和 review 状态。

任务归属通过 prompt 前缀识别：

```text
[WF-001 / TASK-003]
```

如果 prompt 前缀解析失败，或 `taskId -> aoSessionId` 映射无法建立，上层软件必须把任务标记为 `blocked_for_human`，并提供人工绑定入口。

上层软件需要维护 workflow 维度视图，用于展示：

- 一个需求下有哪些任务。
- 每个任务对应哪个 AO session。
- 每个任务的依赖和执行状态。
- 哪些任务需要人工复核。
- 整个 workflow 是否完成。

## 12. 验收标准

- 用户提交需求后，系统能生成设计稿。
- 系统能执行 Codex 与 ClaudeCode 的设计审查整改循环。
- 系统能在轮次上限后进入人工复核。
- 设计通过后，系统能生成结构化任务列表。
- 任务列表中的执行字段只包含 AO 内置角色，不包含具体 agent 或 model。
- AO Dispatcher 单元测试覆盖：当任务 JSON 含 `agent`、`model` 或 `provider` 字段时必须报错，不能透传给 AO。
- 系统能按 `aoRole` 调用 AO 创建 worker session。
- 系统不会生成 `ao spawn --agent ...` 命令。
- `ao session ls --json` 的字段集合有快照测试，字段变更时上层软件测试显式失败。
- 设计审查循环在 mock Codex 与 ClaudeCode 输出下，能在 `maxDesignReviewRounds` 内正确进入 `blocked_for_human`。
- AO Dashboard 能看到所有执行 session。
- 上层软件能维护 workflow、task、aoSessionId 的映射。
- 所有任务完成后，系统能输出最终完成报告，报告包含每轮 design review 决策、每个 task 的 `aoSessionId` 与最终状态。

## 13. AO 后续增强 Backlog

本阶段不修改 AO，以下能力不是上层软件当前版本的前置条件。它们应作为后续 AO 增强 backlog 单独建 issue 或任务跟踪：

- AO 支持 `--metadata workflowId=... --metadata taskId=...`，避免只能依赖 prompt 前缀识别任务归属。
- AO Dashboard 展示 workflow/task 标签，方便在 AO 看板中按上层需求分组。
- AO `batch-spawn` 支持每个任务指定不同 `role`，方便上层软件批量下发结构化任务。
- AO 在 session JSON 中暴露 `workerRole` 字段，方便上层软件或看板按具体 AO 角色过滤。
- 上层软件和 AO 之间建立更正式的任务状态同步协议。
