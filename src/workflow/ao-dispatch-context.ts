import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import type { ExecutionTask, TaskArtifact, TaskPlan } from "../schemas/task-plan.js";
import {
  getCandidatePaths,
  getCompletionChecks,
  getArtifactContractRegistry,
  getRequiredJsonFields,
  serializeTaskMatcher,
  type ArtifactCandidatePath,
  type ArtifactContract,
  type ArtifactCompletionCheck,
  type ArtifactFlagOwnershipContract,
  type ArtifactMarkdownOwnershipContract,
  type ArtifactOwnershipContract
} from "./artifact-contract-registry.js";
import type { ExecutionState } from "./execution-state-store.js";

export interface ResolvedArtifact {
  contractId?: string;
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
  reason?:
    | "missing"
    | "decision_missing"
    | "decision_invalid"
    | "required_when_invalid"
    | "required_when_unmet";
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
  deliveryToken: string;
  promptDigest: string;
  requiredPromptMarkers: string[];
  originalAoPrompt: string;
  projectRoot?: string;
  artifactDir: string;
  mustReadBeforeAskUser: ResolvedArtifact[];
  coreInputs: ResolvedArtifact[];
  dependencyArtifacts: Array<{
    taskId: string;
    title: string;
    artifacts: ResolvedArtifact[];
  }>;
  expectedOutputs: ResolvedArtifact[];
  artifactContracts: DispatchArtifactContract[];
  instructions: string[];
}

export interface DispatchArtifactContract {
  contractId: string;
  kind: string;
  canonicalPath: string;
  contentType: string;
  required: boolean;
  requiredWhen?: string;
  producer: {
    taskMatcher: string;
    taskType?: ArtifactContract["producer"]["taskType"];
    dependencyCondition?: ArtifactContract["producer"]["dependencyCondition"];
    expectedPlanVersion?: ArtifactContract["producer"]["expectedPlanVersion"];
  };
  ownership: ArtifactOwnershipContract;
  markdownOwnership?: ArtifactMarkdownOwnershipContract;
  flagOwnership?: ArtifactFlagOwnershipContract;
  requiredJsonFields: string[];
  completionChecks: ArtifactCompletionCheck[];
  candidatePaths: Array<ArtifactCandidatePath & { absolutePath: string }>;
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
  "Do not call AskUserQuestion before reading every required artifact listed in mustReadBeforeAskUser.",
  "Read the dispatchContextManifest for machine-readable context before reporting missing inputs.",
  "Treat artifactDir as the authoritative control-plane evidence and output directory.",
  "Dependency artifacts are required inputs; read every required dependency artifact from artifactDir before asking for user help.",
  "Only ask the user for missing upstream input after checking mustReadBeforeAskUser absolute paths and confirming those files do not exist.",
  "Expected outputs are files you must create for this task; their absence before the task starts is normal.",
  "Do not treat a missing expected output as missing input.",
  "Write every required expected output to the exact absolute expectedOutputs.path shown in this prompt and manifest.",
  "The artifactContracts section is machine-readable; canonicalPath is the required control-plane output and mirror paths are optional copies only.",
  "If you write a mirror artifact under docs/, schemas/, or config/, also write the canonical artifact before reporting completed.",
  "Do not write control-plane outputs only under your AO worktree.",
  "Before reporting completed, verify every required expectedOutputs.path exists in the canonical artifactDir.",
  "If you accidentally wrote an output under your worktree .ao-control-plane, copy it to the exact expectedOutputs.path before reporting completed.",
  'For AO review manual gates, gate decision JSON must use source="ao_review" and include your AO session id as aoSessionId.',
  'For review/manual_gate tasks, write exactly one structured decision JSON with decision="approved", "rework_required", or "blocked" before reporting.',
  'If decision="rework_required", include targetTaskIds and findings[].targetTaskId/findings[].requiredAction so the scheduler can dispatch upstream rework.',
  "Do not report needs-input for a review finding that can be expressed as a structured decision artifact."
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
  const contextPath = getDispatchContextPath(input.artifactDir, input.task.taskId, input.attempt);
  const manifest = buildDispatchManifest({
    ...input,
    dispatchContextPath: contextPath,
    dispatchId: input.dispatchId
  });
  const missingRequiredArtifacts = await findMissingRequiredArtifacts([
    ...manifest.coreInputs,
    ...manifest.dependencyArtifacts.flatMap((dependency) => dependency.artifacts)
  ]);

  await atomicWriteJson(contextPath, manifest);

  const prompt = buildAoDispatchPrompt({
    task: input.task,
    manifest,
    contextPath
  });

  return { prompt, manifest, contextPath, missingRequiredArtifacts };
}

export function buildAoDispatchPrompt(input: {
  task: ExecutionTask;
  manifest: DispatchContextManifest;
  contextPath: string;
}): string {
  const summary = buildPromptSummary(input.task, input.manifest.workflowId);
  const prompt = [
    summary,
    `workflowId=${input.manifest.workflowId}`,
    `taskId=${input.manifest.taskId}`,
    `任务名称=${input.task.title}`,
    `AO 角色=${input.task.aoRole}`,
    `deliveryToken=${input.manifest.deliveryToken}`,
    "",
    "AO Control Plane Context / AO 控制平面上下文",
    `projectRoot: ${input.manifest.projectRoot ?? ""}`,
    `artifactDir: ${input.manifest.artifactDir}`,
    `dispatchContextManifest: ${input.contextPath}`,
    "",
    "必须先读取调度器上下文文件，然后读取 manifest.originalAoPrompt 作为完整任务正文，再开始执行。",
    input.contextPath,
    "禁止只依据 AO worktree 判断上游产物缺失。",
    "如果无法读取该 manifest，必须 ao report needs-input，并说明 manifest 路径读取失败。",
    "",
    "AskUserQuestion policy:",
    "1. Forbidden before reading every existing file in MUST_READ_BEFORE_ASK_USER.",
    "2. Forbidden when the only evidence is an empty AO worktree.",
    "3. Allowed only after checking the absolute artifactDir paths above and listing exactly which required file is missing.",
    "",
    "coreInputs: control-plane inputs",
    ...input.manifest.coreInputs.map(
      (artifact, index) => `${index + 1}. INPUT ${formatArtifactForPrompt(artifact)}`
    ),
    "",
    "dependencyArtifacts: required task inputs; read before asking for user help",
    ...input.manifest.dependencyArtifacts.flatMap((dependency) => [
      `- ${dependency.taskId} / ${dependency.title}`,
      ...dependency.artifacts.map((artifact) => `  - INPUT ${formatArtifactForPrompt(artifact)}`)
    ]),
    "",
    "expectedOutputs: task outputs to create; absence before task execution is normal",
    ...input.manifest.expectedOutputs.map(
      (artifact, index) => `${index + 1}. OUTPUT ${formatArtifactForPrompt(artifact)}`
    ),
    "",
    "MUST_READ_BEFORE_ASK_USER:",
    ...formatMustReadArtifacts(input.manifest.mustReadBeforeAskUser),
    "",
    "instructions:",
    ...dispatchInstructions.map((instruction, index) => `${index + 1}. ${instruction}`)
  ].join("\n");
  return prompt;
}

export function buildPromptSummary(task: ExecutionTask, workflowId: string): string {
  const fallback = `[${workflowId} / ${task.taskId}] ${task.title}`;
  const firstLine = task.aoPrompt.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (!firstLine || firstLine.length > 100 || looksLikeStructuredContent(firstLine)) {
    return fallback;
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function getDispatchContextPath(
  artifactDir: string,
  taskId: string,
  attempt: number
): string {
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
  dispatchContextPath?: string;
  dispatchId?: string;
}): DispatchContextManifest {
  const artifactDir = normalize(input.artifactDir);
  const deliveryToken = buildDeliveryToken({
    workflowId: input.plan.workflowId,
    taskId: input.task.taskId,
    attempt: input.attempt,
    dispatchId: input.dispatchId
  });
  const requiredPromptMarkers = [
    "dispatchContextManifest",
    deliveryToken,
    buildPromptSummary(input.task, input.plan.workflowId),
    ...(input.dispatchContextPath ? [normalize(input.dispatchContextPath)] : [])
  ];
  const inputArtifacts = resolveInputArtifacts(input.task, input.plan, artifactDir);
  const outputArtifacts = resolveOutputArtifacts(input.task, artifactDir);
  const coreInputs = coreInputFiles.map((item) => ({
    kind: item.kind,
    path: join(artifactDir, item.file),
    required: item.required
  }));
  const dependencyArtifacts = input.task.dependencies.map((dependencyId) => {
    const dependencyTask = input.plan.tasks.find((task) => task.taskId === dependencyId);
    return {
      taskId: dependencyId,
      title: dependencyTask?.title ?? dependencyId,
      artifacts: inputArtifacts.filter((artifact) => artifact.taskId === dependencyId)
    };
  });
  const registry = getArtifactContractRegistry();
  const artifactContracts = outputArtifacts.flatMap((artifact) => {
    const contract = registry.resolveContractForArtifact({
      contractId: artifact.contractId,
      kind: artifact.kind,
      path: artifact.path
    });
    return contract
      ? [
          {
            contractId: contract.id,
            kind: contract.kind,
            canonicalPath: join(artifactDir, contract.canonicalFile),
            contentType: contract.contentType,
            required: contract.required,
            requiredWhen: contract.requiredWhen,
            producer: {
              taskMatcher: serializeTaskMatcher(contract.producer.taskMatcher),
              taskType: contract.producer.taskType,
              dependencyCondition: contract.producer.dependencyCondition,
              expectedPlanVersion: contract.producer.expectedPlanVersion
            },
            ownership: contract.ownership,
            markdownOwnership: contract.markdownOwnership,
            flagOwnership: contract.flagOwnership,
            requiredJsonFields: getRequiredJsonFields(contract),
            completionChecks: getCompletionChecks(contract),
            candidatePaths: getCandidatePaths(contract, {
              artifactDir,
              projectRoot: input.projectRoot,
              workflowId: input.plan.workflowId
            })
          }
        ]
      : [];
  });
  return {
    workflowId: input.plan.workflowId,
    taskId: input.task.taskId,
    attempt: input.attempt,
    deliveryToken,
    promptDigest: sha256(input.task.aoPrompt),
    requiredPromptMarkers,
    originalAoPrompt: input.task.aoPrompt,
    projectRoot: input.projectRoot ? normalize(input.projectRoot) : undefined,
    artifactDir,
    mustReadBeforeAskUser: [
      ...coreInputs.filter((artifact) => artifact.required),
      ...dependencyArtifacts.flatMap((dependency) =>
        dependency.artifacts.filter((artifact) => artifact.required)
      )
    ],
    coreInputs,
    dependencyArtifacts,
    expectedOutputs: outputArtifacts,
    artifactContracts,
    instructions: [...dispatchInstructions]
  };
}

function looksLikeStructuredContent(value: string): boolean {
  return /^(?:\{|\[|```|<\?xml\b|<!doctype\b)/i.test(value.trim());
}

function buildDeliveryToken(input: {
  workflowId: string;
  taskId: string;
  attempt: number;
  dispatchId?: string;
}): string {
  return `ao-dispatch-context:${input.workflowId}:${input.taskId}:attempt-${input.attempt}:${input.dispatchId ?? "reserved"}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  const dependencyEvidence = resolveInputArtifacts(input.task, input.plan, artifactDir).map(
    (artifact) => ({
      taskId: artifact.taskId,
      kind: artifact.kind,
      path: artifact.path
    })
  );
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
    await atomicWriteText(
      flagPath,
      [
        "approved",
        `workflowId=${input.plan.workflowId}`,
        `taskId=${input.task.taskId}`,
        `decidedAt=${now}`
      ].join("\n") + "\n"
    );
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
    throw new Error(
      `Existing manual gate decision is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    decision.workflowId !== input.plan.workflowId ||
    decision.taskId !== input.task.taskId ||
    decision.decision !== "approved" ||
    decision.source !== "control_plane_manual_gate"
  ) {
    throw new Error(
      `Existing manual gate decision does not match ${input.plan.workflowId} / ${input.task.taskId}`
    );
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

export async function findMissingRequiredArtifacts(
  artifacts: ResolvedArtifact[]
): Promise<MissingArtifact[]> {
  const missing: MissingArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact.required) {
      continue;
    }
    try {
      await access(artifact.path);
    } catch {
      missing.push({
        kind: artifact.kind,
        path: artifact.path,
        taskId: artifact.taskId,
        reason: "missing"
      });
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
  const missing = await findMissingRequiredArtifacts(
    outputs.filter((artifact) => artifact.required)
  );
  const conflicts: ConflictArtifact[] = [];
  const conditionalOutputs = outputs.filter((artifact) => artifact.requiredWhen);
  const decisionArtifact = outputs.find(
    (artifact) => isDecisionArtifactKind(artifact.kind) || artifact.kind.includes("verdict")
  );
  let decision: Record<string, unknown> | undefined;

  if (decisionArtifact) {
    try {
      decision = JSON.parse(await readFile(decisionArtifact.path, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      const alreadyMissingDecision = missing.some(
        (artifact) => artifact.path === decisionArtifact.path
      );
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
    missing.push(
      ...conditionalOutputs.map((artifact) => ({
        kind: artifact.kind,
        path: artifact.path,
        taskId: artifact.taskId,
        reason: "decision_missing" as const
      }))
    );
  }

  if (decision && decisionArtifact) {
    conflicts.push(
      ...validateDecisionSource({
        decision,
        decisionArtifact,
        manualGateMode: input.manualGateMode,
        aoSessionId: input.aoSessionId
      })
    );
  }

  if (!decision) {
    return { missingArtifacts: missing, conflictArtifacts: conflicts };
  }

  const requiredByCondition: ResolvedArtifact[] = [];
  for (const artifact of conditionalOutputs) {
    const evaluation = evaluateRequiredWhen(artifact.requiredWhen ?? "", decision);
    if (evaluation === "invalid") {
      missing.push({
        kind: artifact.kind,
        path: artifact.path,
        taskId: artifact.taskId,
        reason: "required_when_invalid"
      });
    } else if (evaluation) {
      requiredByCondition.push(artifact);
    }
  }
  return {
    missingArtifacts: [
      ...missing,
      ...(await findMissingRequiredArtifacts(
        requiredByCondition.map((artifact) => ({ ...artifact, required: true }))
      ))
    ],
    conflictArtifacts: conflicts
  };
}

export function resolveInputArtifacts(
  task: ExecutionTask,
  plan: TaskPlan,
  artifactDir: string
): ResolvedArtifact[] {
  const explicit = (task.inputArtifacts ?? []).map((artifact) =>
    resolveArtifact(artifact, artifactDir)
  );
  const dependencyOutputs = task.dependencies.flatMap((dependencyId) => {
    const dependencyTask = plan.tasks.find((item) => item.taskId === dependencyId);
    if (!dependencyTask) {
      return [];
    }
    return resolveOutputArtifacts(dependencyTask, artifactDir).map((artifact) => ({
      ...artifact,
      taskId: dependencyId
    }));
  });
  const merged = [...explicit];
  for (const artifact of dependencyOutputs) {
    if (
      !merged.some(
        (item) =>
          item.taskId === artifact.taskId &&
          item.kind === artifact.kind &&
          item.path === artifact.path
      )
    ) {
      merged.push(artifact);
    }
  }
  return merged;
}

export function resolveOutputArtifacts(
  task: ExecutionTask,
  artifactDir: string
): ResolvedArtifact[] {
  const explicit = (task.outputArtifacts ?? []).map((artifact) =>
    resolveArtifact(artifact, artifactDir)
  );
  if (explicit.length > 0) {
    return explicit;
  }
  return [];
}

function resolveArtifact(artifact: TaskArtifact, artifactDir: string): ResolvedArtifact {
  const path =
    artifact.path.match(/^[a-zA-Z]:[\\/]/) || artifact.path.startsWith("/")
      ? normalize(artifact.path)
      : normalize(resolve(artifactDir, artifact.path));
  return {
    contractId: artifact.contractId,
    kind: artifact.kind,
    path,
    taskId: artifact.taskId,
    required:
      artifact.required ?? artifact.requiredOnSuccess ?? artifact.requiredWhen === undefined,
    requiredWhen: artifact.requiredWhen
  };
}

function formatArtifactForPrompt(artifact: ResolvedArtifact): string {
  const requirement = artifact.requiredWhen
    ? `requiredWhen=${artifact.requiredWhen}`
    : `required=${artifact.required}`;
  return `${artifact.kind}: ${artifact.path} (${requirement})`;
}

function formatMustReadArtifacts(artifacts: ResolvedArtifact[]): string[] {
  if (artifacts.length === 0) {
    return ["- No required upstream input artifacts."];
  }
  return artifacts.map(
    (artifact, index) =>
      `${index + 1}. READ_FIRST ${artifact.taskId ? `${artifact.taskId} / ` : ""}${artifact.kind}: ${artifact.path}`
  );
}

function getManualGateArtifactPaths(
  task: ExecutionTask,
  artifactDir: string
): { decisionPath: string; flagPath: string } {
  const outputs = resolveOutputArtifacts(task, artifactDir);
  return {
    decisionPath:
      outputs.find((artifact) => isDecisionArtifactKind(artifact.kind))?.path ??
      join(artifactDir, `${task.taskId.toLowerCase()}_gate_decision.json`),
    flagPath:
      outputs.find((artifact) => isFlagArtifactKind(artifact.kind))?.path ??
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

function evaluateRequiredWhen(
  expression: string,
  decision: Record<string, unknown>
): boolean | "invalid" {
  const parts = expression.split("&&").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return "invalid";
  }
  for (const part of parts) {
    const [field, expected, ...rest] = part.split("=");
    if (
      !field?.trim() ||
      expected === undefined ||
      expected.trim().length === 0 ||
      rest.length > 0
    ) {
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
  const expectedSource =
    input.manualGateMode === "ao_review" ? "ao_review" : "control_plane_manual_gate";
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
    const aoSessionId =
      typeof input.decision.aoSessionId === "string" ? input.decision.aoSessionId : undefined;
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
  return (
    /(^|_)(gate_)?decision$/.test(kind) ||
    kind.includes("decision") ||
    kind.includes("verdict") ||
    kind.includes("决策") ||
    kind.includes("裁决")
  );
}

function isFlagArtifactKind(kind: string): boolean {
  return /(^|_)flag$/.test(kind) || kind.includes("flag") || kind.includes("标记");
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
