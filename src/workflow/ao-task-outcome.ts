import { access, readFile } from "node:fs/promises";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";
import { resolveOutputArtifacts } from "./ao-dispatch-context.js";
import type { AoSessionSnapshot } from "./ao-status.js";
import { readReviewerSourceFields } from "./ao-review-source-proof.js";
import { getArtifactContractRegistry } from "./artifact-contract-registry.js";
import type { ExecutionState, ExecutionTaskState } from "./execution-state-store.js";

export interface AoOutcomeFinding {
  id: string;
  severity: "blocking" | "major" | "minor";
  summary: string;
  targetTaskId?: string;
  requiredAction?: string;
  evidencePaths?: string[];
}

export type AoTaskOutcome =
  | { kind: "completed"; source: "ao_status" | "artifact" | "report"; message?: string }
  | { kind: "approved"; source: "artifact"; decisionPath: string; flagPath?: string }
  | {
      kind: "rework_required";
      source: "artifact";
      failureKind: "manual_gate_rework_required";
      decisionPath: string;
      reworkRequestPath?: string;
      targetTaskIds: string[];
      findings: AoOutcomeFinding[];
      message?: string;
    }
  | {
      kind: "blocked";
      source: "artifact" | "report" | "ao_status";
      failureKind?: "ao_task_failed" | "ao_task_stuck" | "manual_gate_blocked";
      reason: string;
      findings?: AoOutcomeFinding[];
    }
  | {
      kind: "needs_structured_decision";
      source: "ao_status" | "report";
      failureKind: "ao_task_needs_structured_decision";
      requiredOutputs: string[];
      reportSummary?: string;
      message: string;
    }
  | {
      kind: "needs_human";
      source: "ao_status" | "report";
      failureKind: "ao_task_needs_input";
      reason: string;
    }
  | {
      kind: "invalid";
      failureKind: "artifact_output_conflict" | "artifact_contract_violation";
      reason: string;
      details?: unknown;
    };

const terminalSuccessStatuses = new Set(["completed", "mergeable", "merged", "done"]);
const terminalFailureStatuses = new Set(["failed", "stuck", "ci_failed"]);

export async function resolveAoTaskOutcome(input: {
  plan: TaskPlan;
  task: ExecutionTask;
  taskState: ExecutionTaskState;
  state: ExecutionState;
  session?: AoSessionSnapshot;
  artifactDir: string;
  manualGateMode?: "manual_approve" | "ao_review";
}): Promise<AoTaskOutcome> {
  const decisionArtifact = findDecisionArtifact(input.task, input.artifactDir);
  const requiredOutputs = resolveOutputArtifacts(input.task, input.artifactDir)
    .filter((artifact) => artifact.required || artifact.requiredWhen)
    .map((artifact) => artifact.path);
  const isGateLike = isManualGateOrReviewTask(input.task);

  if (decisionArtifact && input.manualGateMode !== "manual_approve") {
    const decisionRead = await readJsonIfExists(decisionArtifact.path);
    if (decisionRead.exists && !("value" in decisionRead && decisionRead.value)) {
      return {
        kind: "invalid",
        failureKind: "artifact_contract_violation",
        reason: `Decision artifact is invalid JSON: ${decisionArtifact.path}`,
        details: decisionRead.error
      };
    }
    if ("value" in decisionRead && decisionRead.value) {
      const decision = decisionRead.value;
      if (isGateLike && input.manualGateMode === "ao_review") {
        const sessionId = input.taskState.aoSessionId ?? input.session?.id;
        if (!sessionId || !hasCanonicalReviewerSourceProof(decision, sessionId)) {
          return {
            kind: "invalid",
            failureKind: "artifact_output_conflict",
            reason: "AO review decision artifact does not contain canonical reviewer source proof",
            details: { decisionPath: decisionArtifact.path, aoSessionId: sessionId }
          };
        }
      }
      return resolveDecisionOutcome({
        decision,
        decisionPath: decisionArtifact.path,
        task: input.task,
        plan: input.plan,
        state: input.state,
        artifactDir: input.artifactDir
      });
    }
  }

  const status = input.session?.status;
  const expectsStructuredDecision = Boolean(decisionArtifact || requiredOutputs.length > 0);
  if (status && terminalSuccessStatuses.has(status) && isGateLike && input.manualGateMode === "ao_review" && expectsStructuredDecision) {
    return {
      kind: "needs_structured_decision",
      source: "ao_status",
      failureKind: "ao_task_needs_structured_decision",
      requiredOutputs,
      reportSummary: input.session?.reportedState,
      message: "AO review finished but did not write a structured decision artifact"
    };
  }
  if (status && terminalSuccessStatuses.has(status)) {
    return { kind: "completed", source: "ao_status", message: `AO session status is ${status}` };
  }

  if ((status === "needs_input" || status === "waiting") && isGateLike && expectsStructuredDecision) {
    return {
      kind: "needs_structured_decision",
      source: "ao_status",
      failureKind: "ao_task_needs_structured_decision",
      requiredOutputs,
      reportSummary: input.session?.reportedState,
      message: status === "waiting"
        ? "AO reviewer reported waiting but did not write a structured decision artifact"
        : "AO requested input but did not write a structured decision artifact"
    };
  }

  if (status === "needs_input" || status === "waiting") {
    return {
      kind: "needs_human",
      source: "ao_status",
      failureKind: "ao_task_needs_input",
      reason: status === "waiting"
        ? "AO session reported waiting and no structured outcome artifact was found"
        : "AO session requested input and no structured outcome artifact was found"
    };
  }

  if (status && terminalFailureStatuses.has(status)) {
    return {
      kind: "blocked",
      source: "ao_status",
      failureKind: status === "stuck" ? "ao_task_stuck" : "ao_task_failed",
      reason: `AO session reported terminal status: ${status}`
    };
  }

  return {
    kind: "needs_human",
    source: "ao_status",
    failureKind: "ao_task_needs_input",
    reason: status
      ? `Unexpected non-actionable AO status reached outcome resolver: ${status}`
      : "AO outcome resolver was called without a session status"
  };
}

export function hasCanonicalReviewerSourceProof(
  json: Record<string, unknown>,
  aoSessionId: string
): boolean {
  const fields = readReviewerSourceFields(json);
  if (fields.source !== "ao_review") {
    return false;
  }
  if (fields.aoSessionId !== aoSessionId) {
    return false;
  }
  return !fields.reviewerIndependence ||
    fields.reviewerIndependence.reviewerSessionId === aoSessionId;
}

function resolveDecisionOutcome(input: {
  decision: Record<string, unknown>;
  decisionPath: string;
  task: ExecutionTask;
  plan: TaskPlan;
  state: ExecutionState;
  artifactDir: string;
}): AoTaskOutcome {
  const decisionValue = typeof input.decision.decision === "string"
    ? input.decision.decision
    : typeof input.decision.verdict === "string"
      ? input.decision.verdict
      : undefined;
  if (decisionValue === "approved" || decisionValue === "pass") {
    return {
      kind: "approved",
      source: "artifact",
      decisionPath: input.decisionPath,
      flagPath: findFlagArtifact(input.task, input.artifactDir)?.path
    };
  }
  if (decisionValue === "rework_required" || decisionValue === "fail") {
    const targetTaskIds = readStringArray(input.decision.targetTaskIds);
    const findings = readFindings(input.decision.findings);
    const targetValidation = validateReworkTargets({
      plan: input.plan,
      gateTask: input.task,
      state: input.state,
      targetTaskIds,
      findings
    });
    if (targetValidation) {
      return targetValidation;
    }
    return {
      kind: "rework_required",
      source: "artifact",
      failureKind: "manual_gate_rework_required",
      decisionPath: input.decisionPath,
      reworkRequestPath: findReworkArtifact(input.task, input.artifactDir)?.path,
      targetTaskIds,
      findings,
      message: typeof input.decision.rationale === "string" ? input.decision.rationale : undefined
    };
  }
  if (decisionValue === "blocked" || decisionValue === "rejected") {
    return {
      kind: "blocked",
      source: "artifact",
      reason: typeof input.decision.rationale === "string"
        ? input.decision.rationale
        : `Decision artifact reports ${decisionValue}`,
      findings: readFindings(input.decision.findings)
    };
  }
  return {
    kind: "invalid",
    failureKind: "artifact_contract_violation",
    reason: "Decision artifact does not contain a supported decision value",
    details: { decisionPath: input.decisionPath, decision: decisionValue }
  };
}

function validateReworkTargets(input: {
  plan: TaskPlan;
  gateTask: ExecutionTask;
  state: ExecutionState;
  targetTaskIds: string[];
  findings: AoOutcomeFinding[];
}): AoTaskOutcome | undefined {
  if (input.targetTaskIds.length === 0) {
    return {
      kind: "invalid",
      failureKind: "artifact_contract_violation",
      reason: "rework_required decision must include targetTaskIds"
    };
  }
  const tasksById = new Map(input.plan.tasks.map((task) => [task.taskId, task]));
  const upstream = collectUpstreamTaskIds(input.gateTask, tasksById);
  for (const targetTaskId of input.targetTaskIds) {
    if (!tasksById.has(targetTaskId)) {
      return {
        kind: "invalid",
        failureKind: "artifact_contract_violation",
        reason: `Unknown rework target task ${targetTaskId}`
      };
    }
    if (!upstream.has(targetTaskId)) {
      return {
        kind: "invalid",
        failureKind: "artifact_contract_violation",
        reason: `Rework target ${targetTaskId} is not upstream of gate ${input.gateTask.taskId}`
      };
    }
    if (input.state.taskStates[targetTaskId]?.status === "superseded") {
      return {
        kind: "invalid",
        failureKind: "artifact_contract_violation",
        reason: `Rework target ${targetTaskId} is superseded and must be handled by replan`
      };
    }
  }
  for (const finding of input.findings) {
    if (finding.targetTaskId && !input.targetTaskIds.includes(finding.targetTaskId)) {
      return {
        kind: "invalid",
        failureKind: "artifact_contract_violation",
        reason: `Finding ${finding.id} references targetTaskId ${finding.targetTaskId} outside targetTaskIds`
      };
    }
  }
  return undefined;
}

function collectUpstreamTaskIds(
  task: ExecutionTask,
  tasksById: Map<string, ExecutionTask>
): Set<string> {
  const result = new Set<string>();
  const visit = (taskId: string): void => {
    if (result.has(taskId)) {
      return;
    }
    result.add(taskId);
    const dependency = tasksById.get(taskId);
    for (const parentId of dependency?.dependencies ?? []) {
      visit(parentId);
    }
  };
  for (const dependencyId of task.dependencies) {
    visit(dependencyId);
  }
  return result;
}

function findDecisionArtifact(task: ExecutionTask, artifactDir: string) {
  return resolveOutputArtifacts(task, artifactDir).find((artifact) => {
    const contract = getArtifactContractRegistry().resolveContractForArtifact(artifact);
    const kind = contract?.kind ?? artifact.kind;
    return isDecisionKind(kind);
  });
}

function findFlagArtifact(task: ExecutionTask, artifactDir: string) {
  return resolveOutputArtifacts(task, artifactDir).find((artifact) => {
    const contract = getArtifactContractRegistry().resolveContractForArtifact(artifact);
    const kind = contract?.kind ?? artifact.kind;
    return /flag|approved/i.test(kind);
  });
}

function findReworkArtifact(task: ExecutionTask, artifactDir: string) {
  return resolveOutputArtifacts(task, artifactDir).find((artifact) => {
    const contract = getArtifactContractRegistry().resolveContractForArtifact(artifact);
    const kind = contract?.kind ?? artifact.kind;
    return /rework|replan|返工|回流/i.test(kind);
  });
}

function isDecisionKind(kind: string): boolean {
  return /decision|verdict|决策|裁决/i.test(kind);
}

function isManualGateOrReviewTask(task: ExecutionTask): boolean {
  return task.dependencyCondition === "manual_gate" || task.type === "review";
}

async function readJsonIfExists(
  path: string
): Promise<{ exists: false } | { exists: true; value?: Record<string, unknown>; error?: string }> {
  try {
    await access(path);
  } catch {
    return { exists: false };
  }
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) ? { exists: true, value } : { exists: true, error: "not an object" };
  } catch (error) {
    return { exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readFindings(value: unknown): AoOutcomeFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((item, index) => ({
    id: typeof item.id === "string" ? item.id : `F${index + 1}`,
    severity: isSeverity(item.severity) ? item.severity : "blocking",
    summary: typeof item.summary === "string" ? item.summary : String(item.title ?? item.body ?? ""),
    targetTaskId: typeof item.targetTaskId === "string" ? item.targetTaskId : undefined,
    requiredAction: typeof item.requiredAction === "string" ? item.requiredAction : undefined,
    evidencePaths: readStringArray(item.evidencePaths)
  }));
}

function isSeverity(value: unknown): value is AoOutcomeFinding["severity"] {
  return value === "blocking" || value === "major" || value === "minor";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
