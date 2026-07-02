import { z } from "zod";
import { designCoverageTraceSchema, planReadinessSchema } from "./task-plan.js";

export const taskPlanApprovalReportSchema = z.object({
  workflowId: z.string().min(1),
  planVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  approved: z.boolean(),
  planReadiness: planReadinessSchema,
  dispatchSummary: z.object({
    dispatchableTaskCount: z.number().int().nonnegative(),
    waitingTaskCount: z.number().int().nonnegative(),
    manualGateTaskCount: z.number().int().nonnegative(),
    blockingFindingCount: z.number().int().nonnegative()
  }),
  designCoverageTrace: z.array(designCoverageTraceSchema),
  findingSummary: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      severity: z.enum(["blocking", "major", "minor", "warning", "observation"]),
      status: z.enum(["unresolved", "addressed", "accepted_as_is"])
    })
  )
});

export type TaskPlanApprovalReport = z.output<typeof taskPlanApprovalReportSchema>;
