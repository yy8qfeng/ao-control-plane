# AO Control Plane

AO Control Plane 是 Agent Orchestrator 的上层控制软件骨架，负责需求设计审查层和结构化计划执行层。

它不替代 AO。AO 仍然作为执行引擎，负责通过内置角色创建和运行执行会话；本项目负责需求输入、设计审查循环、任务计划校验、AO 任务下发、状态采集和交付报告。

## 目标边界

- 上层软件负责调用 Codex 生成需求设计文档。
- 上层软件负责调用 ClaudeCode 审查需求设计。
- 上层软件负责驱动 Codex 整改或说明不改。
- 上层软件负责调用 ClaudeCode 输出结构化任务列表。
- 进入执行层后，只允许指定 AO 内置角色，不允许指定 Codex、ClaudeCode、模型、provider 或 agent。
- AO 负责执行任务、维护 session、提供看板和状态输出。

## 当前状态

这是第一版可运行骨架，已经包含：

- TypeScript 项目结构。
- CLI 入口。
- 需求、设计审查、任务计划 schema。
- AO 内置角色校验。
- AO CLI 适配器。
- Codex / ClaudeCode 适配器接口和占位实现。
- 设计审查循环与计划执行编排骨架。

## 安装

```bash
pnpm install
pnpm build
```

## 使用

校验任务计划：

```bash
pnpm dev validate-plan examples/task-plan.example.json
```

预演执行任务计划：

```bash
pnpm dev execute-plan examples/task-plan.example.json --dry-run
```

真实下发 AO：

```bash
pnpm dev execute-plan examples/task-plan.example.json --project-root C:\workspace\agent-orchestrator
```

## 推荐实施路径

第一阶段先把 Codex、ClaudeCode、AO 三类适配器跑通，并保持所有中间结果落盘。

第二阶段增加持久化状态机，记录每轮设计、审查、整改、任务执行和人工门禁。

第三阶段增加 Web 控制台，展示需求、审查轮次、任务依赖、AO session 映射和最终报告。

第四阶段再评估是否需要给 AO 增加最小能力，例如 session JSON 中返回 `workerRole`。
