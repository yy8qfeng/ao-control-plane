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

## 服务管理

开发模式启动网页控制台：

```bash
pnpm dev serve --port 4317
```

停止网页控制台：

```bash
pnpm dev stop-service --port 4317
```

重启网页控制台：

```bash
pnpm dev restart-service --port 4317
```

打包编译后启动：

```bash
pnpm build
pnpm start serve --port 4317
```

打包编译后停止：

```bash
pnpm start stop-service --port 4317
```

打包编译后重启：

```bash
pnpm build
pnpm start restart-service --port 4317
```

如果页面没有变化，优先执行 `restart-service`，然后在浏览器中按 `Ctrl + F5` 强制刷新。`stop-service` 会自动过滤系统进程 `PID 0`，不会再尝试停止 Windows 的 `Idle (0)` 进程。

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

`id` 可省略，系统会自动生成；`maxDesignReviewRounds` 默认是 `3`。流程会调用 Codex 生成设计稿，调用 ClaudeCode 审查设计稿并输出结构化任务计划。生成文件会写入 `.ao-control-plane\<workflowId>`，包括当前设计稿 `design.md`、每轮 `review-*.json`、汇总 `reviews.json`、`workflow.json` 和最终 `task-plan.json`。

如果 ClaudeCode 审查输出不是合法 JSON，系统会先尝试自动修复；仍无法修复时，会把原始审查文本作为未解决意见纳入整改，避免设计审查流程因为格式问题直接中断。任务计划输出如果仍无法通过 schema 校验，会写入 `invalid-claude-output.txt` 和 `human-review-required.json`，需要人工复核后再继续。

生成执行计划后，可以直接执行：

```bash
pnpm dev execute-plan .ao-control-plane\WF-001\task-plan.json --project-root C:\workspace\your-project
```

启动网页控制台：

```bash
pnpm dev serve
```

重启网页控制台：

```bash
pnpm dev restart-service --port 4317
```

停止网页控制台：

```bash
pnpm dev stop-service --port 4317
```

默认只绑定 `127.0.0.1`。控制台可以浏览本机目录并触发本地 Codex / ClaudeCode / AO 命令，不要暴露到公网；如确需绑定 `0.0.0.0`，必须显式添加 `--allow-public-host`。

打开输出的本地地址后，可以在网页里输入需求、讨论记录、验收标准和约束，点击生成设计与任务计划。生成结果会落盘到 `.ao-control-plane\<workflowId>`。

网页控制台支持暂停补充：

1. `生成需求设计并审查`：调用真实 Codex / ClaudeCode 流程，Codex 生成需求设计，ClaudeCode 审查，Codex 根据意见整改并重新审查，通过后生成结构化任务计划。
2. `补充需求并重新审查`：在当前 workflow 中更新需求内容，重新生成设计并从第 1 轮开始计数，通过后重新生成任务计划。
3. `生成任务计划`：保留分阶段流程入口，基于已通过的设计生成结构化任务计划。
4. `预演执行`：按任务计划预演 AO 下发。

点击“选择”可以从弹框选择项目目录。最近使用过的目录会记录在 `.ao-control-plane\project-config.json`，服务重启后默认选择上一次目录。如果选择项目目录，生成文件会落盘到该目录下的 `.ao-control-plane\<workflowId>`，AO 执行也会在该目录下运行。最大设计审查轮次为手填数字，默认值为 `3`。

需求表单草稿也会保存在 `.ao-control-plane\project-config.json`。页面会自动保存当前表单，也可以点击“保存草稿”手动保存；“历史草稿”下拉框可以恢复不同需求的最后一次草稿。同一个 `workflowId` 只保留最后一次记录，不保存同一需求的每次变更。重新生成同一个历史需求时，会继续更新该需求绑定的 `.ao-control-plane\<workflowId>` 目录，不会重复创建新的需求目录；点击历史草稿旁边的“删除”会删除所选历史记录，并同步删除对应的 `.ao-control-plane\<workflowId>` 生成文件夹；点击“清空草稿”只清空当前回显草稿，不删除历史草稿和生成文件。

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
