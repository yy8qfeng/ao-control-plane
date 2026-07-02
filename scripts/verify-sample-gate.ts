import { readFile } from "node:fs/promises";
import { validateTaskPlanApprovalGate } from "../src/workflow/task-plan-gates.js";

async function main() {
  const designPath = "C:/workspace/fast-transport/.ao-control-plane/WF-20260630T031508Z/design.md";
  const planPath = "C:/workspace/fast-transport/.ao-control-plane/WF-20260630T031508Z/task-plan.json";

  const design = await readFile(designPath, "utf8");
  const planRaw = await readFile(planPath, "utf8");
  const plan = JSON.parse(planRaw);

  const result = validateTaskPlanApprovalGate({
    workflowId: plan.workflowId,
    approvedDesign: design,
    deferredFindings: [],
    plan,
    previousReviews: []
  });

  console.log(JSON.stringify({
    passed: result.passed,
    totalFindings: result.findings.length,
    findingIds: result.findings.map((f) => f.id),
    findings: result.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title }))
  }, null, 2));
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
