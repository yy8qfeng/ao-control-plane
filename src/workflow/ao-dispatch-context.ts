import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import type { ExecutionTask, TaskArtifact, TaskPlan } from "../schemas/task-plan.js";
import { manualGateTemplates, taskOutputTemplates, type ManualGateTemplate } from "./task-artifact-templates.js";
import type { ExecutionState } from "./execution-state-store.js";

export interface ResolvedArtifact {
  kind: string;
  path: string;
  taskId?: string;
  required: boolean;
  requiredWhen?: string;
}

export interface MissingArtifact {
  kind: string;
  path: string;
  taskId?: string;
  reason?: "missing" | "decision_missing" | "decision_invalid" | "required_when_invalid" | "required_when_unmet";
}

export interface ConflictArtifact {
  kind: string;
  path: string;
  taskId?: string;
  reason: "source_mismatch" | "ao_session_mismatch";
  expected: string;
  actual?: string;
}

export interface ArtifactValidationResult {
  missingArtifacts: MissingArtifact[];
  conflictArtifacts: ConflictArtifact[];
}

export interface DispatchContextManifest {
  workflowId: string;
  taskId: string;
  attempt: number;
  projectRoot?: string;
  artifactDir: string;
  coreInputs: ResolvedArtifact[];
  dependencyArtifacts: Array<{
    taskId: string;
    title: string;
    artifacts: ResolvedArtifact[];
  }>;
  expectedOutputs: ResolvedArtifact[];
  instructions: string[];
}

export interface BuiltDispatchContext {
  prompt: string;
  manifest: DispatchContextManifest;
  contextPath: string;
  missingRequiredArtifacts: MissingArtifact[];
}

export interface SynthesizedManualGateArtifacts {
  generatedArtifacts: string[];
  writtenPaths: string[];
  decisionPath: string;
  flagPath?: string;
}

export interface ExistingManualGateArtifacts extends SynthesizedManualGateArtifacts {
  reused: true;
}

const coreInputFiles = [
  { kind: "requirement", file: "requirement.json", required: false },
  { kind: "design", file: "design.md", required: false },
  { kind: "task_plan", file: "task-plan.json", required: true },
  { kind: "execution_state", file: "execution-state.json", required: true },
  { kind: "execution_log", file: "execution-log.jsonl", required: false }
] as const;

const dispatchInstructions = [
  "Do not rely only on the AO worktree.",
  "An empty AO worktree is not evidence that control-plane artifacts are missing.",
  "Read the dispatchContextManifest for machine-readable context before reporting missing inputs.",
  "Treat artifactDir as the authoritative control-plane evidence and output directory.",
  "Dependency artifacts are required inputs; read every required dependency artifact from artifactDir before asking for user help.",
  "Expected outputs are files you must create for this task; their absence before the task starts is normal.",
  "Do not treat a missing expected output as missing input.",
  "Write every required expected output to the exact absolute expectedOutputs.path shown in this prompt and manifest.",
  "Do not write control-plane outputs only under your AO worktree.",
  "Before reporting completed, verify every required expectedOutputs.path exists in the canonical artifactDir.",
  "If you accidentally wrote an output under your worktree .ao-control-plane, copy it to the exact expectedOutputs.path before reporting completed.",
  "For AO review manual gates, gate decision JSON must use source=\"ao_review\" and include your AO session id as aoSessionId."
] as const;

export async function buildAoDispatchContext(input: {
  task: ExecutionTask;
  plan: TaskPlan;
  state: ExecutionState;
  projectRoot?: string;
  artifactDir: string;
  attempt: number;
  dispatchId?: string;
}): Promise<BuiltDispatchContext> {
  const manifest = buildDispatchManifest(input);
  const contextPath = getDispatchContextPath(input.artifactDir, input.task.taskId, input.attempt);
  const missingRequiredArtifacts = await findMissingRequiredArtifacts([
    ...manifest.coreInputs,
    ...manifest.dependencyArtifacts.flatMap((dependency) => dependency.artifacts)
  ]);

  await atomicWriteJson(contextPath, manifest);

  const prompt = [
    input.task.aoPrompt,
    "",
    "---",
    "AO Control Plane Context / AO 控制平面上下文",
    "",
    `workflowId: ${manifest.workflowId}`,
    `taskId: ${manifest.taskId}`,
    `projectRoot: ${manifest.projectRoot ?? ""}`,
    `artifactDir: ${manifest.artifactDir}`,
    `dispatchContextManifest: ${contextPath}`,
    "",
    "coreInputs: control-plane inputs",
    ...manifest.coreInputs.map((artifact, index) => `${index + 1}. INPUT ${formatArtifactForPrompt(artifact)}`),
    "",
    "dependencyArtifacts: required task inputs; read before asking for user help",
    ...manifest.dependencyArtifacts.flatMap((dependency) => [
      `- ${dependency.taskId} / ${dependency.title}`,
      ...dependency.artifacts.map((artifact) => `  - INPUT ${formatArtifactForPrompt(artifact)}`)
    ]),
    "",
    "expectedOutputs: task outputs to create; absence before task execution is normal",
    ...manifest.expectedOutputs.map((artifact, index) => `${index + 1}. OUTPUT ${formatArtifactForPrompt(artifact)}`),
    "",
    "instructions:",
    ...dispatchInstructions.map((instruction, index) => `${index + 1}. ${instruction}`),
    "---"
  ].join("\n");

  return { prompt, manifest, contextPath, missingRequiredArtifacts };
}

export function getDispatchContextPath(artifactDir: string, taskId: string, attempt: number): string {
  return join(
    artifactDir,
    "dispatch-context",
    `ao-dispatch-context-${taskId}-attempt-${attempt}.json`
  );
}

export function buildDispatchManifest(input: {
  task: ExecutionTask;
  plan: TaskPlan;
  projectRoot?: string;
  artifactDir: string;
  attempt: number;
}): DispatchContextManifest {
  const artifactDir = normalize(input.artifactDir);
  const inputArtifacts = resolveInputArtifacts(input.task, input.plan, artifactDir);
  const outputArtifacts = resolveOutputArtifacts(input.task, artifactDir);
  return {
    workflowId: input.plan.workflowId,
    taskId: input.task.taskId,
    attempt: input.attempt,
    projectRoot: input.projectRoot ? normalize(input.projectRoot) : undefined,
    artifactDir,
    coreInputs: coreInputFiles.map((item) => ({
      kind: item.kind,
      path: join(artifactDir, item.file),
      required: item.required
    })),
    dependencyArtifacts: input.task.dependencies.map((dependencyId) => {
      const dependencyTask = input.plan.tasks.find((task) => task.taskId === dependencyId);
      return {
        taskId: dependencyId,
        title: dependencyTask?.title ?? dependencyId,
        artifacts: inputArtifacts.filter((artifact) => artifact.taskId === dependencyId)
      };
    }),
    expectedOutputs: outputArtifacts,
    instructions: [...dispatchInstructions]
  };
}

export async function synthesizeManualGateArtifacts(input: {
  task: ExecutionTask;
  plan: TaskPlan;
  state: ExecutionState;
  artifactDir: string;
  rationale: string;
  actor: "user" | "cli";
}): Promise<SynthesizedManualGateArtifacts> {
  const artifactDir = normalize(input.artifactDir);
  const { decisionPath, flagPath } = getManualGateArtifactPaths(input.task, artifactDir);
  const now = new Date().toISOString();
  const dependencyEvidence = resolveInputArtifacts(input.task, input.plan, artifactDir).map((artifact) => ({
    taskId: artifact.taskId,
    kind: artifact.kind,
    path: artifact.path
  }));
  const decision = {
    workflowId: input.plan.workflowId,
    taskId: input.task.taskId,
    decision: "approved",
    decidedBy: input.actor,
    decidedAt: now,
    rationale: input.rationale,
    source: "control_plane_manual_gate",
    dependencyEvidence
  };
  const writtenPaths: string[] = [];
  try {
    await atomicWriteJson(decisionPath, decision);
    writtenPaths.push(decisionPath);
    await atomicWriteText(flagPath, [
      "approved",
      `workflowId=${input.plan.workflowId}`,
      `taskId=${input.task.taskId}`,
      `decidedAt=${now}`
    ].join("\n") + "\n");
    writtenPaths.push(flagPath);
  } catch (error) {
    await cleanupFiles(writtenPaths);
    throw error;
  }
  return {
    generatedArtifacts: writtenPaths.map((file) => normalize(file).slice(artifactDir.length + 1)),
    writtenPaths,
    decisionPath,
    flagPath
  };
}

export async function findExistingManualGateArtifacts(input: {
  task: ExecutionTask;
  plan: TaskPlan;
  artifactDir: string;
}): Promise<ExistingManualGateArtifacts | undefined> {
  const artifactDir = normalize(input.artifactDir);
  const { decisionPath, flagPath } = getManualGateArtifactPaths(input.task, artifactDir);
  const decisionExists = await fileExists(decisionPath);
  const flagExists = flagPath ? await fileExists(flagPath) : true;
  if (!decisionExists && !flagExists) {
    return undefined;
  }
  if (!decisionExists || !flagExists) {
    throw new Error(`Existing manual gate artifacts are incomplete for ${input.task.taskId}`);
  }
  let decision: Record<string, unknown>;
  try {
    decision = JSON.parse(await readFile(decisionPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Existing manual gate decision is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    decision.workflowId !== input.plan.workflowId ||
    decision.taskId !== input.task.taskId ||
    decision.decision !== "approved" ||
    decision.source !== "control_plane_manual_gate"
  ) {
    throw new Error(`Existing manual gate decision does not match ${input.plan.workflowId} / ${input.task.taskId}`);
  }
  const writtenPaths = [decisionPath, ...(flagPath ? [flagPath] : [])];
  return {
    reused: true,
    generatedArtifacts: writtenPaths.map((file) => normalize(file).slice(artifactDir.length + 1)),
    writtenPaths,
    decisionPath,
    flagPath
  };
}

export async function cleanupFiles(files: string[]): Promise<void> {
  await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)));
}

export async function findMissingRequiredArtifacts(artifacts: ResolvedArtifact[]): Promise<MissingArtifact[]> {
  const missing: MissingArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact.required) {
      continue;
    }
    try {
      await access(artifact.path);
    } catch {
      missing.push({ kind: artifact.kind, path: artifact.path, taskId: artifact.taskId, reason: "missing" });
    }
  }
  return missing;
}

export async function validateTaskOutputArtifacts(input: {
  task: ExecutionTask;
  artifactDir: string;
  manualGateMode?: "manual_approve" | "ao_review";
  aoSessionId?: string;
}): Promise<ArtifactValidationResult> {
  const outputs = resolveOutputArtifacts(input.task, input.artifactDir);
  const missing = await findMissingRequiredArtifacts(outputs.filter((artifact) => artifact.required));
  const conflicts: ConflictArtifact[] = [];
  const conditionalOutputs = outputs.filter((artifact) => artifact.requiredWhen);
  const decisionArtifact = outputs.find((artifact) => isDecisionArtifactKind(artifact.kind) || artifact.kind.includes("verdict"));
  let decision: Record<string, unknown> | undefined;

  if (decisionArtifact) {
    try {
      decision = JSON.parse(await readFile(decisionArtifact.path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      const alreadyMissingDecision = missing.some((artifact) => artifact.path === decisionArtifact.path);
      if (!alreadyMissingDecision) {
        missing.push({
          kind: decisionArtifact.kind,
          path: decisionArtifact.path,
          taskId: decisionArtifact.taskId,
          reason: error instanceof SyntaxError ? "decision_invalid" : "decision_missing"
        });
      }
    }
  } else if (conditionalOutputs.length > 0) {
    missing.push(...conditionalOutputs.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.path,
      taskId: artifact.taskId,
      reason: "decision_missing" as const
    })));
  }

  if (decision && decisionArtifact) {
    conflicts.push(...validateDecisionSource({
      decision,
      decisionArtifact,
      manualGateMode: input.manualGateMode,
      aoSessionId: input.aoSessionId
    }));
  }

  if (!decision) {
    return { missingArtifacts: missing, conflictArtifacts: conflicts };
  }

  const requiredByCondition: ResolvedArtifact[] = [];
  for (const artifact of conditionalOutputs) {
    const evaluation = evaluateRequiredWhen(artifact.requiredWhen ?? "", decision);
    if (evaluation === "invalid") {
      missing.push({ kind: artifact.kind, path: artifact.path, taskId: artifact.taskId, reason: "required_when_invalid" });
    } else if (evaluation) {
      requiredByCondition.push(artifact);
    }
  }
  return {
    missingArtifacts: [
      ...missing,
      ...await findMissingRequiredArtifacts(requiredByCondition.map((artifact) => ({ ...artifact, required: true })))
    ],
    conflictArtifacts: conflicts
  };
}

export function resolveInputArtifacts(
  task: ExecutionTask,
  plan: TaskPlan,
  artifactDir: string
): ResolvedArtifact[] {
  const explicit = (task.inputArtifacts ?? []).map((artifact) => resolveArtifact(artifact, artifactDir));
  if (explicit.length > 0) {
    return explicit;
  }

  return task.dependencies.flatMap((dependencyId) => {
    const dependencyTask = plan.tasks.find((item) => item.taskId === dependencyId);
    if (!dependencyTask) {
      return [];
    }
    return resolveOutputArtifacts(dependencyTask, artifactDir).map((artifact) => ({
      ...artifact,
      taskId: dependencyId
    }));
  });
}

export function resolveOutputArtifacts(task: ExecutionTask, artifactDir: string): ResolvedArtifact[] {
  const explicit = (task.outputArtifacts ?? []).map((artifact) => resolveArtifact(artifact, artifactDir));
  if (explicit.length > 0) {
    return explicit;
  }

  const text = taskText(task);
  const manualGate = inferManualGateTemplate(text);
  if (manualGate) {
    return [
      { kind: manualGate.decision.kind, path: join(artifactDir, manualGate.decision.file), required: manualGate.decision.required ?? true },
      { kind: manualGate.flag.kind, path: join(artifactDir, manualGate.flag.file), required: manualGate.flag.required ?? false, requiredWhen: manualGate.flag.requiredWhen },
      ...(manualGate.rework
        ? [
          { kind: manualGate.rework.kind, path: join(artifactDir, manualGate.rework.file), required: false, requiredWhen: "decision=rework_required" },
          { kind: `${manualGate.rework.kind}_rejected`, path: join(artifactDir, manualGate.rework.file), required: false, requiredWhen: "decision=rejected" }
        ]
        : [])
    ];
  }
  for (const template of taskOutputTemplates) {
    if (template.match.test(text)) {
      return template.artifacts.map((artifact) => ({
        kind: artifact.kind,
        path: join(artifactDir, artifact.file),
        required: artifact.required ?? true,
        requiredWhen: artifact.requiredWhen
      }));
    }
  }
  if (/复核失败回流/.test(text)) {
    return [{ kind: "g0_replan_request", path: join(artifactDir, "g0_replan_request.json"), required: true }];
  }
  if (/(^|\n)(QA verdict|Write QA verdict)|产出\s*qa_verdict\.json|QA verdict.*裁决/i.test(text)) {
    return [{ kind: "qa_verdict", path: join(artifactDir, "qa_verdict.json"), required: true }];
  }
  if (/planning gate|task plan gate|任务计划.*门禁|计划.*审批/i.test(text)) {
    return [{ kind: "task_plan_approval_report", path: join(artifactDir, "task-plan-approval-report.json"), required: true }];
  }
  if (/contract freeze|契约冻结/i.test(text)) {
    return [{ kind: "contract_freeze_evidence", path: join(artifactDir, "contract-freeze-evidence.json"), required: true }];
  }
  if (/release decision|发布.*决策文件/i.test(text)) {
    return [{ kind: "release_decision", path: join(artifactDir, "release_decision.json"), required: true }];
  }
  return [];
}

function resolveArtifact(artifact: TaskArtifact, artifactDir: string): ResolvedArtifact {
  const path = artifact.path.match(/^[a-zA-Z]:[\\/]/) || artifact.path.startsWith("/")
    ? normalize(artifact.path)
    : normalize(resolve(artifactDir, artifact.path));
  return {
    kind: artifact.kind,
    path,
    taskId: artifact.taskId,
    required: artifact.required ?? artifact.requiredOnSuccess ?? artifact.requiredWhen === undefined,
    requiredWhen: artifact.requiredWhen
  };
}

function formatArtifactForPrompt(artifact: ResolvedArtifact): string {
  const requirement = artifact.requiredWhen
    ? `requiredWhen=${artifact.requiredWhen}`
    : `required=${artifact.required}`;
  return `${artifact.kind}: ${artifact.path} (${requirement})`;
}

function getManualGateArtifactPaths(task: ExecutionTask, artifactDir: string): { decisionPath: string; flagPath: string } {
  const outputs = resolveOutputArtifacts(task, artifactDir);
  return {
    decisionPath: outputs.find((artifact) => isDecisionArtifactKind(artifact.kind))?.path ??
      join(artifactDir, `${task.taskId.toLowerCase()}_gate_decision.json`),
    flagPath: outputs.find((artifact) => isFlagArtifactKind(artifact.kind))?.path ??
      join(artifactDir, `${task.taskId.toLowerCase()}_approved.flag`)
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function evaluateRequiredWhen(expression: string, decision: Record<string, unknown>): boolean | "invalid" {
  const parts = expression.split("&&").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return "invalid";
  }
  for (const part of parts) {
    const [field, expected, ...rest] = part.split("=");
    if (!field?.trim() || expected === undefined || expected.trim().length === 0 || rest.length > 0) {
      return "invalid";
    }
    if (String(decision[field.trim()] ?? "") !== expected.trim()) {
      return false;
    }
  }
  return true;
}

function validateDecisionSource(input: {
  decision: Record<string, unknown>;
  decisionArtifact: ResolvedArtifact;
  manualGateMode?: "manual_approve" | "ao_review";
  aoSessionId?: string;
}): ConflictArtifact[] {
  if (!input.manualGateMode || !isDecisionArtifactKind(input.decisionArtifact.kind)) {
    return [];
  }
  const conflicts: ConflictArtifact[] = [];
  const source = typeof input.decision.source === "string" ? input.decision.source : undefined;
  const expectedSource = input.manualGateMode === "ao_review" ? "ao_review" : "control_plane_manual_gate";
  if (source !== expectedSource) {
    conflicts.push({
      kind: input.decisionArtifact.kind,
      path: input.decisionArtifact.path,
      taskId: input.decisionArtifact.taskId,
      reason: "source_mismatch",
      expected: expectedSource,
      actual: source
    });
  }
  if (input.manualGateMode === "ao_review") {
    const aoSessionId = typeof input.decision.aoSessionId === "string" ? input.decision.aoSessionId : undefined;
    if (aoSessionId !== input.aoSessionId) {
      conflicts.push({
        kind: input.decisionArtifact.kind,
        path: input.decisionArtifact.path,
        taskId: input.decisionArtifact.taskId,
        reason: "ao_session_mismatch",
        expected: input.aoSessionId ?? "",
        actual: aoSessionId
      });
    }
  }
  return conflicts;
}

function isDecisionArtifactKind(kind: string): boolean {
  return /(^|_)(gate_)?decision$/.test(kind) ||
    kind.includes("decision") ||
    kind.includes("verdict") ||
    kind.includes("决策") ||
    kind.includes("裁决");
}

function isFlagArtifactKind(kind: string): boolean {
  return /(^|_)flag$/.test(kind) || kind.includes("flag") || kind.includes("标记");
}

function inferManualGateTemplate(text: string): ManualGateTemplate | undefined {
  return manualGateTemplates.find((template) => template.match.test(text));
}

function taskText(task: ExecutionTask): string {
  return [task.title, task.description, task.aoPrompt, ...task.acceptanceCriteria].join("\n");
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(file: string, value: string): Promise<void> {
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmpFile, value, "utf8");
  try {
    await rename(tmpFile, file);
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined);
    await rename(tmpFile, file).catch(() => {
      throw error;
    });
  }
  await rm(tmpFile, { force: true }).catch(() => undefined);
}
