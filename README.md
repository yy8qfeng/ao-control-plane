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

从 `requirement.json` 运行完整治理流程：

```bash
pnpm dev run-workflow examples/requirement.example.json --project-root C:\workspace\your-project
```

`requirement.json` 格式：

```json
{
  "id": "WF-001",
  "title": "需求标题",
  "source": "user",
  "description": "需求描述",
  "acceptanceCriteria": ["验收标准"],
  "constraints": ["约束条件"],
  "maxDesignReviewRounds": 3
}
```

`id` 可省略，系统会自动生成；`maxDesignReviewRounds` 默认是 `3`。流程会调用 Codex 生成设计稿，调用 ClaudeCode 审查设计稿并输出结构化任务计划。生成文件会写入 `.ao-control-plane\<workflowId>`，包括每轮 `design-v*.md`、`review-*.json`、汇总 `reviews.json`、`workflow.json` 和最终 `task-plan.json`。

如果 ClaudeCode 输出不是合法 JSON，或不符合 schema，流程会失败并写入 `invalid-claude-output.txt` 和 `human-review-required.json`，需要人工复核后再继续。

生成执行计划后，可以直接执行：

```bash
pnpm dev execute-plan .ao-control-plane\WF-001\task-plan.json --project-root C:\workspace\your-project
```

启动网页控制台：

```bash
pnpm dev serve
```

默认只绑定 `127.0.0.1`。控制台可以浏览本机目录并触发本地 Codex / ClaudeCode / AO 命令，不要暴露到公网；如确需绑定 `0.0.0.0`，必须显式添加 `--allow-public-host`。

打开输出的本地地址后，可以在网页里输入需求、讨论记录、验收标准和约束，点击生成设计与任务计划。生成结果会落盘到 `.ao-control-plane\<workflowId>`。

网页控制台支持暂停补充：

1. `生成需求设计并审查`：调用真实 Codex / ClaudeCode 流程，Codex 生成需求设计，ClaudeCode 审查，Codex 根据意见整改并重新审查，通过后生成结构化任务计划。
2. `补充需求并重新审查`：在当前 workflow 中更新需求内容，重新生成设计并从第 1 轮开始计数，通过后重新生成任务计划。
3. `生成任务计划`：保留分阶段流程入口，基于已通过的设计生成结构化任务计划。
4. `预演执行`：按任务计划预演 AO 下发。

点击“选择”可以从弹框选择项目目录。最近使用过的目录会记录在 `.ao-control-plane\project-config.json`，服务重启后默认选择上一次目录。如果选择项目目录，生成文件会落盘到该目录下的 `.ao-control-plane\<workflowId>`，AO 执行也会在该目录下运行。最大设计审查轮次为手填数字，默认值为 `3`。

如果设计审查未通过，workflow 会进入 `blocked_for_human`，此时不会生成 `task-plan.json`；只有设计通过并完成任务拆解后，才会写入可供 `execute-plan` 使用的 `task-plan.json`。

校验任务计划：

```bash
pnpm dev validate-plan examples/task-plan.example.json
```

预演执行任务计划：

```bash
pnpm dev execute-plan examples/task-plan.example.json --dry-run
```

采集 AO 状态并映射回任务：

```bash
pnpm dev collect-status examples/task-plan.example.json --sessions-file examples/ao-sessions.example.json
```

输出最终交付报告：

```bash
pnpm dev report examples/task-plan.example.json examples/design-reviews.example.json --sessions-file examples/ao-sessions.example.json
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
