import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StructuredOutputError, type ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { runWorkflow } from "./run-workflow.js";

describe("runWorkflow", () => {
  it("persists every design, review, and the final task plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-001",
        title: "Feature",
        source: "test",
        description: "Build the feature.",
        acceptanceCriteria: ["Feature works"],
        constraints: ["Use AO roles only"],
        maxDesignReviewRounds: 2
      }),
      "utf8"
    );

    const codex: CodexAdapter = {
      async createDesign() {
        return "# Feature\n\n## 背景与问题定义\nBuild it.";
      },
      async reviseDesign() {
        throw new Error("should not revise approved design");
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(input): Promise<DesignReview> {
        return {
          workflowId: input.workflowId,
          round: input.round,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: input.designVersion,
          reviewDecision: "approved",
          findings: []
        };
      },
      async createTaskPlan(input): Promise<TaskPlan> {
        return {
          workflowId: input.workflowId,
          title: "Plan",
          tasks: [
            {
              taskId: "TASK-001",
              workflowId: input.workflowId,
              title: "Implement feature",
              description: "Implement the feature.",
              type: "implementation",
              dependencies: [],
              dependencyCondition: "all_completed",
              aoRole: "backend-senior",
              acceptanceCriteria: ["Feature works"],
              aoPrompt: "[WF-001 / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. Feature works\n上下文摘要：Follow the approved design.",
              status: "pending"
            }
          ]
        };
      }
    };

    const result = await runWorkflow({
      requirementFile,
      artifactRoot: join(root, "artifacts"),
      codex,
      claudeCode
    });

    expect(result.workflow.status).toBe("executing");
    expect(result.taskPlanPath).toBe(join(root, "artifacts", "WF-001", "task-plan.json"));
    await expect(readFile(join(root, "artifacts", "WF-001", "design.md"), "utf8")).resolves.toContain(
      "# Feature"
    );
    await expect(readFile(join(root, "artifacts", "WF-001", "review-1.json"), "utf8")).resolves.toContain(
      '"reviewDecision": "approved"'
    );
    await expect(readFile(join(root, "artifacts", "WF-001", "task-plan.json"), "utf8")).resolves.toContain(
      '"taskId": "TASK-001"'
    );
  });

  it("fails and writes human review artifacts when ClaudeCode returns invalid structured output", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-002",
        title: "Feature",
        description: "Build the feature."
      }),
      "utf8"
    );

    const codex: CodexAdapter = {
      async createDesign() {
        return "# Feature";
      },
      async reviseDesign() {
        return "# Feature revised";
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(): Promise<DesignReview> {
        throw new StructuredOutputError("invalid review", "not json");
      },
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should not plan after failed review");
      }
    };

    await expect(
      runWorkflow({
        requirementFile,
        artifactRoot: join(root, "artifacts"),
        codex,
        claudeCode
      })
    ).rejects.toThrow("invalid review");

    await expect(
      readFile(join(root, "artifacts", "WF-002", "invalid-claude-output.txt"), "utf8")
    ).resolves.toBe("not json");
    await expect(
      readFile(join(root, "artifacts", "WF-002", "human-review-required.json"), "utf8")
    ).resolves.toContain("invalid review");
  });

  it("continues an existing workflow by revising the current design instead of creating a new draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-CONTINUE",
        title: "Feature",
        source: "test",
        description: "Build the feature.",
        maxDesignReviewRounds: 2
      }),
      "utf8"
    );

    let createDesignCalls = 0;
    let reviseDesignCalls = 0;
    const codex: CodexAdapter = {
      async createDesign() {
        createDesignCalls += 1;
        return "# Feature\n\n## 初稿\nv1";
      },
      async reviseDesign(input) {
        reviseDesignCalls += 1;
        return `${input.currentDesign}\n\n## 续跑更新\n${input.review.findings[0]?.title ?? ""}`;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(input): Promise<DesignReview> {
        return {
          workflowId: input.workflowId,
          round: input.round,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: input.designVersion,
          reviewDecision: "approved",
          findings: []
        };
      },
      async createTaskPlan(input): Promise<TaskPlan> {
        return {
          workflowId: input.workflowId,
          title: "Plan",
          tasks: [
            {
              taskId: "TASK-001",
              workflowId: input.workflowId,
              title: "Implement feature",
              description: "Implement the feature.",
              type: "implementation",
              dependencies: [],
              dependencyCondition: "all_completed",
              aoRole: "backend-senior",
              acceptanceCriteria: ["Feature works"],
              aoPrompt:
                "[WF-CONTINUE / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. Feature works\n上下文摘要：Follow the approved design.",
              status: "pending"
            }
          ]
        };
      }
    };

    const artifactRoot = join(root, "artifacts");
    await runWorkflow({ requirementFile, artifactRoot, codex, claudeCode });
    await runWorkflow({ requirementFile, artifactRoot, codex, claudeCode });

    expect(createDesignCalls).toBe(1);
    expect(reviseDesignCalls).toBe(1);
    const artifactEntries = await readdir(join(artifactRoot, "WF-CONTINUE"));
    expect(artifactEntries.filter((entry) => /^design-v\d+\.md$/.test(entry))).toEqual([]);
    await expect(readFile(join(artifactRoot, "WF-CONTINUE", "design.md"), "utf8")).resolves.toContain(
      "续跑更新"
    );
  });
});
