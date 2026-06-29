import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";

export interface ClaudeCodeAdapter {
  reviewDesign(input: { requirementId: string; round: number; design: string }): Promise<DesignReview>;
  createTaskPlan(input: { requirementId: string; approvedDesign: string }): Promise<TaskPlan>;
}

export class PlaceholderClaudeCodeAdapter implements ClaudeCodeAdapter {
  async reviewDesign(input: {
    requirementId: string;
    round: number;
    design: string;
  }): Promise<DesignReview> {
    return {
      requirementId: input.requirementId,
      round: input.round,
      conclusion: input.design.trim().length > 0 ? "approved" : "needs_revision",
      findings: []
    };
  }

  async createTaskPlan(input: {
    requirementId: string;
    approvedDesign: string;
  }): Promise<TaskPlan> {
    return {
      id: `${input.requirementId}-plan`,
      title: "结构化执行计划",
      tasks: [
        {
          id: "task-001",
          title: "根据已批准设计实现功能",
          type: "development",
          aoRole: "backend-senior",
          prompt: input.approvedDesign,
          dependencies: [],
          dependencyCondition: "all_completed"
        }
      ]
    };
  }
}
