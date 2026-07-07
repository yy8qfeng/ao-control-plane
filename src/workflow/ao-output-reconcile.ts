import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { execa } from "execa";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";
import {
  resolveOutputArtifacts,
  validateTaskOutputArtifacts,
  type ConflictArtifact
} from "./ao-dispatch-context.js";
import { readReviewerSourceFields } from "./ao-review-source-proof.js";
import {
  buildCandidatePathVariants,
  getArtifactContractRegistry,
  type ArtifactContract
} from "./artifact-contract-registry.js";
import type { AoSessionSnapshot } from "./ao-status.js";
import type { ExecutionState } from "./execution-state-store.js";

export interface RecoveredArtifact {
  kind: string;
  from: string;
  to: string;
  normalized: boolean;
}

export interface ReconcileSkip {
  kind?: string;
  path?: string;
  reason:
    "manual_approve_protected" | "worktree_not_found" | "no_ao_session" | "no_expected_outputs";
  detail?: string;
}

export interface ArtifactConflict {
  contractId?: string;
  kind: string;
  path: string;
  candidatePath?: string;
  candidateSource?: string;
  priority?: number;
  accepted?: boolean;
  rejectReason?:
    | "canonical_exists_with_different_content"
    | "workflow_mismatch"
    | "task_mismatch"
    | "source_proof_missing"
    | "unsupported_decision"
    | "content_type_mismatch";
  reason:
    | "canonical_exists_with_different_content"
    | "workflow_mismatch"
    | "task_mismatch"
    | "source_proof_missing"
    | "unsupported_decision"
    | "content_type_mismatch"
    | "ambiguous_candidates";
  expected?: string;
  actual?: string;
}

export type ConflictArtifactCandidate = ArtifactConflict;

export interface MissingArtifactCandidate {
  kind: string;
  path: string;
  candidatePath: string;
  reason: "candidate_missing";
}

export interface ReconcileFailure {
  contractId?: string;
  kind: string;
  path: string;
  reason:
    | "atomic_write_failed"
    | "canonical_validation_failed"
    | "invalid_json"
    | "io_error"
    | "path_escape"
    | "rollback_failed"
    | "size_exceeded"
    | "content_type_mismatch";
  detail?: string;
  rolledBackPaths?: string[];
  rollbackFailedPaths?: string[];
}

export interface ArtifactReconcileResult {
  recovered: RecoveredArtifact[];
  skipped: ReconcileSkip[];
  conflicts: ArtifactConflict[];
  missing: MissingArtifactCandidate[];
  failures: ReconcileFailure[];
  ambiguousCandidates?: ArtifactConflict[];
  contractViolations?: ArtifactConflict[];
  worktreeResolution?: {
    path?: string;
    discoveredVia?: "input" | "session" | "git_worktree" | "fallback";
  };
}

export interface WorktreeCleanupCandidate {
  sessionId: string;
  worktreePath: string;
  branch?: string;
  reason: string;
  dryRunCommand?: string;
}

export interface WorktreeCleanupResult {
  candidates: WorktreeCleanupCandidate[];
  removed: string[];
  skipped: Array<{ sessionId: string; reason: string }>;
  failures: Array<{ sessionId: string; reason: string; detail?: string }>;
  dryRun: boolean;
}

interface PreparedArtifact {
  contractId?: string;
  kind: string;
  candidatePath: string;
  targetPath: string;
  content: string;
  normalized: boolean;
}

type PreparedCandidateResult =
  | { artifact: PreparedArtifact }
  | { failure: ReconcileFailure }
  | { conflict: ConflictArtifactCandidate };

const flagSizeLimitBytes = 64 * 1024;
const jsonSizeLimitBytes = 1024 * 1024;
const allowedDecisions = new Set(["approved", "rework_required", "blocked", "rejected"]);

export async function reconcileTaskOutputsFromAoWorktree(input: {
  task: ExecutionTask;
  plan: TaskPlan;
  state: ExecutionState;
  artifactDir: string;
  projectRoot?: string;
  aoSessionId?: string;
  manualGateMode?: "manual_approve" | "ao_review";
  worktreePath?: string;
  sessions?: AoSessionSnapshot[];
}): Promise<ArtifactReconcileResult> {
  const result = createEmptyResult();
  if (input.manualGateMode === "manual_approve") {
    result.skipped.push({ reason: "manual_approve_protected" });
    return result;
  }
  if (!input.aoSessionId) {
    result.skipped.push({ reason: "no_ao_session" });
    return result;
  }
  const aoSessionId = input.aoSessionId;
  const outputs = resolveOutputArtifacts(input.task, input.artifactDir);
  if (outputs.length === 0) {
    result.skipped.push({ reason: "no_expected_outputs" });
    return result;
  }

  const worktreeResolution = await resolveAoWorktreePath({
    aoSessionId,
    worktreePath: input.worktreePath,
    projectRoot: input.projectRoot,
    sessions: input.sessions
  });
  result.worktreeResolution = worktreeResolution;
  const worktreePath = worktreeResolution.path;
  if (!worktreePath) {
    result.skipped.push({
      reason: "worktree_not_found",
      detail: `AO worktree not found for ${input.aoSessionId}`
    });
    return result;
  }

  const prepared: PreparedArtifact[] = [];
  const registry = getArtifactContractRegistry();
  for (const output of outputs) {
    const contract = registry.resolveContractForArtifact(output);
    const targetPath = normalize(output.path);
    const relativeOutput = safeRelative(input.artifactDir, targetPath);
    if (!relativeOutput) {
      result.failures.push({
        kind: output.kind,
        path: targetPath,
        reason: "path_escape",
        detail: "expectedOutput path is outside artifactDir"
      });
      continue;
    }
    const candidates = await resolveCandidatePaths({
      contract,
      worktreePath,
      workflowId: input.plan.workflowId,
      relativeOutput,
      targetPath,
      taskId: input.task.taskId,
      kind: output.kind
    });
    const existingCandidates: Array<{ path: string; source?: string; priority?: number }> = [];
    for (const candidate of candidates) {
      if (!isPathInside(candidate.path, worktreePath)) {
        result.failures.push({
          kind: output.kind,
          path: candidate.path,
          reason: "path_escape",
          detail: "candidate path escapes AO worktree"
        });
        continue;
      }
      if (await fileExists(candidate.path)) {
        existingCandidates.push(candidate);
      }
    }
    const candidatePath = existingCandidates[0]?.path ?? candidates[0]?.path;
    if (!candidatePath) {
      result.missing.push({
        kind: output.kind,
        path: targetPath,
        candidatePath: targetPath,
        reason: "candidate_missing"
      });
      continue;
    }
    if (!isPathInside(candidatePath, worktreePath)) {
      result.failures.push({
        kind: output.kind,
        path: targetPath,
        reason: "path_escape",
        detail: "candidate path escapes AO worktree"
      });
      continue;
    }
    if (!isPathInside(targetPath, input.artifactDir)) {
      result.failures.push({
        kind: output.kind,
        path: targetPath,
        reason: "path_escape",
        detail: "target path escapes artifactDir"
      });
      continue;
    }
    if (!(await fileExists(candidatePath))) {
      result.missing.push({
        kind: output.kind,
        path: targetPath,
        candidatePath,
        reason: "candidate_missing"
      });
      continue;
    }
    if (existingCandidates.length > 1) {
      const evaluated = await Promise.all(
        existingCandidates.map(async (candidate) => ({
          candidate,
          prepared: await prepareCandidate({
            kind: output.kind,
            contract,
            candidatePath: candidate.path,
            targetPath,
            workflowId: input.plan.workflowId,
            taskId: input.task.taskId,
            aoSessionId,
            manualGateMode: input.manualGateMode
          })
        }))
      );
      const accepted = evaluated.filter((item) => "artifact" in item.prepared);
      const rejected = evaluated.filter((item) => "conflict" in item.prepared || "failure" in item.prepared);
      const highestAcceptedPriority = Math.max(
        ...accepted.map(({ candidate }) => candidate.priority ?? 0)
      );
      const acceptedAtHighestPriority = accepted.filter(
        ({ candidate }) => (candidate.priority ?? 0) === highestAcceptedPriority
      );
      if (acceptedAtHighestPriority.length > 1 && rejected.length === 0) {
        const ambiguous = acceptedAtHighestPriority.map(({ candidate }) => ({
          contractId: contract?.id,
          kind: output.kind,
          path: targetPath,
          candidatePath: candidate.path,
          candidateSource: candidate.source,
          priority: candidate.priority,
          accepted: false,
          reason: "ambiguous_candidates" as const
        }));
        result.ambiguousCandidates = [...(result.ambiguousCandidates ?? []), ...ambiguous];
      } else if (acceptedAtHighestPriority.length === 1 && rejected.length === 0) {
        const selected = acceptedAtHighestPriority[0]?.prepared;
        if (selected && "artifact" in selected) {
          prepared.push(selected.artifact);
        }
      } else {
        result.conflicts.push(
          ...accepted.map(({ candidate }) => ({
            contractId: contract?.id,
            kind: output.kind,
            path: targetPath,
            candidatePath: candidate.path,
            candidateSource: candidate.source,
            priority: candidate.priority,
            accepted: true,
            reason: "ambiguous_candidates" as const
          })),
          ...rejected.map(({ candidate, prepared }) =>
            toRejectedConflict({
              contractId: contract?.id,
              kind: output.kind,
              path: targetPath,
              candidatePath: candidate.path,
              candidateSource: candidate.source,
              priority: candidate.priority,
              prepared
            })
          )
        );
      }
      continue;
    }
    const existing = await readOptionalText(targetPath);
    if (existing !== undefined) {
      const sizeFailure = await validateCandidateSize(output.kind, candidatePath);
      if (sizeFailure) {
        result.failures.push(sizeFailure);
        continue;
      }
      const candidate = await readFile(candidatePath, "utf8");
      if (normalizeText(existing) !== normalizeText(candidate)) {
        result.conflicts.push({
          contractId: contract?.id,
          kind: output.kind,
          path: targetPath,
          candidatePath,
          candidateSource: existingCandidates[0]?.source,
          priority: existingCandidates[0]?.priority,
          accepted: false,
          rejectReason: "canonical_exists_with_different_content",
          reason: "canonical_exists_with_different_content"
        });
      }
      continue;
    }
    const normalized = await prepareCandidate({
      kind: output.kind,
      contract,
      candidatePath,
      targetPath,
      workflowId: input.plan.workflowId,
      taskId: input.task.taskId,
      aoSessionId,
      manualGateMode: input.manualGateMode
    });
    if ("failure" in normalized) {
      result.failures.push(normalized.failure);
      continue;
    }
    if ("conflict" in normalized) {
      result.contractViolations = [...(result.contractViolations ?? []), normalized.conflict];
      continue;
    }
    prepared.push(normalized.artifact);
  }

  if (
    result.failures.length > 0 ||
    result.conflicts.length > 0 ||
    (result.ambiguousCandidates?.length ?? 0) > 0 ||
    (result.contractViolations?.length ?? 0) > 0 ||
    prepared.length === 0
  ) {
    return result;
  }

  const writtenPaths: string[] = [];
  try {
    for (const artifact of prepared) {
      await atomicWriteText(artifact.targetPath, artifact.content);
      writtenPaths.push(artifact.targetPath);
      result.recovered.push({
        kind: artifact.kind,
        from: artifact.candidatePath,
        to: artifact.targetPath,
        normalized: artifact.normalized
      });
    }
  } catch (error) {
    const rollback = await rollbackFiles(writtenPaths);
    result.failures.push({
      kind: "artifact_output",
      path: writtenPaths.at(-1) ?? input.artifactDir,
      reason: rollback.failed.length > 0 ? "rollback_failed" : "atomic_write_failed",
      detail: formatErrorMessage(error),
      rolledBackPaths: rollback.rolledBack,
      rollbackFailedPaths: rollback.failed
    });
  }
  return result;
}

export async function rollbackRecoveredArtifacts(
  result: ArtifactReconcileResult
): Promise<ReconcileFailure | undefined> {
  const paths = result.recovered.map((artifact) => artifact.to);
  const rollback = await rollbackFiles(paths);
  if (rollback.failed.length > 0) {
    return {
      kind: "artifact_output",
      path: rollback.failed[0] ?? "",
      reason: "rollback_failed",
      rolledBackPaths: rollback.rolledBack,
      rollbackFailedPaths: rollback.failed
    };
  }
  return {
    kind: "artifact_output",
    path: paths[0] ?? "",
    reason: "canonical_validation_failed",
    rolledBackPaths: rollback.rolledBack
  };
}

export async function listWorktreeCleanupCandidates(input: {
  state: ExecutionState;
  projectRoot?: string;
  sessions?: AoSessionSnapshot[];
}): Promise<WorktreeCleanupCandidate[]> {
  if (!input.projectRoot) {
    return [];
  }
  const currentSessionIds = new Set(
    Object.values(input.state.taskStates)
      .filter((task) => task.status === "working")
      .map((task) => task.aoSessionId)
      .filter((value): value is string => Boolean(value))
  );
  const sessionIds = new Set<string>([
    ...(input.state.supersededSessions ?? []),
    ...Object.values(input.state.taskStates)
      .filter((task) => task.status === "completed" && task.aoSessionId)
      .map((task) => task.aoSessionId as string)
  ]);
  const candidates: WorktreeCleanupCandidate[] = [];
  for (const sessionId of sessionIds) {
    if (currentSessionIds.has(sessionId)) {
      continue;
    }
    const session = input.sessions?.find((item) => item.id === sessionId);
    if (
      session?.status &&
      ["working", "spawning", "needs_input", "running"].includes(session.status)
    ) {
      continue;
    }
    if (session?.prUrl && !isClosedOrMerged(session)) {
      continue;
    }
    const worktreePath = await resolveAoWorktreePath({
      aoSessionId: sessionId,
      projectRoot: input.projectRoot,
      sessions: input.sessions
    });
    if (!worktreePath.path || !(await isCleanGitWorktree(worktreePath.path))) {
      continue;
    }
    const branch = await readGitBranch(worktreePath.path);
    if (!branch?.startsWith("session/")) {
      continue;
    }
    candidates.push({
      sessionId,
      worktreePath: worktreePath.path,
      branch,
      reason: input.state.supersededSessions?.includes(sessionId)
        ? "superseded session with clean worktree and no open PR"
        : "completed session with clean worktree and no open PR",
      dryRunCommand: `git -C ${input.projectRoot} worktree remove --force ${worktreePath}`
    });
  }
  return candidates;
}

export async function cleanupAoWorktrees(input: {
  state: ExecutionState;
  projectRoot?: string;
  sessionIds: string[];
  dryRun?: boolean;
  sessions?: AoSessionSnapshot[];
}): Promise<WorktreeCleanupResult> {
  const candidates = await listWorktreeCleanupCandidates(input);
  const candidateBySessionId = new Map(
    candidates.map((candidate) => [candidate.sessionId, candidate])
  );
  const result: WorktreeCleanupResult = {
    candidates,
    removed: [],
    skipped: [],
    failures: [],
    dryRun: input.dryRun ?? false
  };
  if (!input.projectRoot) {
    result.failures.push({ sessionId: "", reason: "projectRoot is required" });
    return result;
  }
  for (const sessionId of input.sessionIds) {
    const candidate = candidateBySessionId.get(sessionId);
    if (!candidate) {
      result.skipped.push({ sessionId, reason: "not a safe cleanup candidate" });
      continue;
    }
    if (input.dryRun) {
      result.skipped.push({ sessionId, reason: "dryRun" });
      continue;
    }
    try {
      await execa("git", [
        "-C",
        input.projectRoot,
        "worktree",
        "remove",
        "--force",
        candidate.worktreePath
      ]);
      await execa("git", ["-C", input.projectRoot, "worktree", "prune"]);
      result.removed.push(sessionId);
    } catch (error) {
      result.failures.push({
        sessionId,
        reason: "git worktree remove failed",
        detail: formatErrorMessage(error)
      });
    }
  }
  return result;
}

async function prepareCandidate(input: {
  kind: string;
  contract?: ArtifactContract;
  candidatePath: string;
  targetPath: string;
  workflowId: string;
  taskId: string;
  aoSessionId: string;
  manualGateMode?: "manual_approve" | "ao_review";
}): Promise<PreparedCandidateResult> {
  try {
    if (input.contract && !candidateMatchesContentType(input.contract, input.candidatePath)) {
      return {
        conflict: {
          contractId: input.contract.id,
          kind: input.kind,
          path: input.targetPath,
          candidatePath: input.candidatePath,
          reason: "content_type_mismatch",
          rejectReason: "content_type_mismatch",
          accepted: false,
          expected: input.contract.contentType,
          actual: input.candidatePath.split(".").pop()
        }
      };
    }
    const sizeFailure = await validateCandidateSize(input.kind, input.candidatePath);
    if (sizeFailure) {
      return { failure: sizeFailure };
    }
    const content = await readFile(input.candidatePath, "utf8");
    if (!input.candidatePath.endsWith(".json")) {
      return {
        artifact: {
          kind: input.kind,
          contractId: input.contract?.id,
          candidatePath: input.candidatePath,
          targetPath: input.targetPath,
          content,
          normalized: false
        }
      };
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      return {
        failure: {
          kind: input.kind,
          contractId: input.contract?.id,
          path: input.candidatePath,
          reason: "invalid_json",
          detail: formatErrorMessage(error)
        }
      };
    }
    if (json.workflowId !== input.workflowId) {
      return {
        conflict: {
          kind: input.kind,
          contractId: input.contract?.id,
          path: input.targetPath,
          candidatePath: input.candidatePath,
          reason: "workflow_mismatch",
          expected: input.workflowId,
          actual: typeof json.workflowId === "string" ? json.workflowId : undefined
        }
      };
    }
    if (json.taskId !== input.taskId) {
      return {
        conflict: {
          kind: input.kind,
          contractId: input.contract?.id,
          path: input.targetPath,
          candidatePath: input.candidatePath,
          reason: "task_mismatch",
          expected: input.taskId,
          actual: typeof json.taskId === "string" ? json.taskId : undefined
        }
      };
    }
    if (input.manualGateMode === "ao_review" && isDecisionArtifactKind(input.kind)) {
      const decision = typeof json.decision === "string" ? json.decision : undefined;
      if (!decision || !allowedDecisions.has(decision)) {
        return {
          conflict: {
            kind: input.kind,
            path: input.targetPath,
            candidatePath: input.candidatePath,
            reason: "unsupported_decision",
            actual: decision
          }
        };
      }
      const proof = hasAoReviewSourceProof(json, input.aoSessionId);
      if (!proof) {
        return {
          conflict: {
            kind: input.kind,
            path: input.targetPath,
            candidatePath: input.candidatePath,
            reason: "source_proof_missing",
            expected: input.aoSessionId,
            actual:
              typeof json.aoSessionId === "string"
                ? json.aoSessionId
                : typeof json.source === "string"
                  ? json.source
                  : undefined
          }
        };
      }
      const originalSource = typeof json.source === "string" ? json.source : undefined;
      const normalized = {
        ...json,
        source: "ao_review",
        aoSessionId: input.aoSessionId,
        ...(originalSource && originalSource !== "ao_review"
          ? { normalizedFrom: { source: originalSource } }
          : {})
      };
      return {
        artifact: {
          kind: input.kind,
          contractId: input.contract?.id,
          candidatePath: input.candidatePath,
          targetPath: input.targetPath,
          content: `${JSON.stringify(normalized, null, 2)}\n`,
          normalized: true
        }
      };
    }
    return {
      artifact: {
        kind: input.kind,
        contractId: input.contract?.id,
        candidatePath: input.candidatePath,
        targetPath: input.targetPath,
        content: `${JSON.stringify(json, null, 2)}\n`,
        normalized: false
      }
    };
  } catch (error) {
    return {
      failure: {
        kind: input.kind,
        contractId: input.contract?.id,
        path: input.candidatePath,
        reason: "io_error",
        detail: formatErrorMessage(error)
      }
    };
  }
}

function toRejectedConflict(input: {
  contractId?: string;
  kind: string;
  path: string;
  candidatePath: string;
  candidateSource?: string;
  priority?: number;
  prepared: PreparedCandidateResult;
}): ArtifactConflict {
  if ("conflict" in input.prepared) {
    return {
      ...input.prepared.conflict,
      contractId: input.prepared.conflict.contractId ?? input.contractId,
      candidateSource: input.candidateSource,
      priority: input.priority,
      accepted: false,
      rejectReason:
        input.prepared.conflict.rejectReason ??
        (input.prepared.conflict.reason === "ambiguous_candidates"
          ? "canonical_exists_with_different_content"
          : input.prepared.conflict.reason)
    };
  }
  return {
    contractId: input.contractId,
    kind: input.kind,
    path: input.path,
    candidatePath: input.candidatePath,
    candidateSource: input.candidateSource,
    priority: input.priority,
    accepted: false,
    reason: "content_type_mismatch",
    rejectReason: "content_type_mismatch",
    actual: "failure" in input.prepared ? input.prepared.failure.reason : undefined
  };
}

async function resolveAoWorktreePath(input: {
  aoSessionId: string;
  worktreePath?: string;
  projectRoot?: string;
  sessions?: AoSessionSnapshot[];
}): Promise<{ path?: string; discoveredVia?: "input" | "session" | "git_worktree" | "fallback" }> {
  if (input.worktreePath && (await fileExists(input.worktreePath))) {
    return { path: normalize(input.worktreePath), discoveredVia: "input" };
  }
  const session = input.sessions?.find((item) => item.id === input.aoSessionId);
  if (session?.worktreePath && (await fileExists(session.worktreePath))) {
    return { path: normalize(session.worktreePath), discoveredVia: "session" };
  }
  if (input.projectRoot) {
    const gitWorktree = await findGitWorktree(input.projectRoot, input.aoSessionId);
    if (gitWorktree) {
      return { path: gitWorktree, discoveredVia: "git_worktree" };
    }
  }
  const root = join(homedir(), ".agent-orchestrator", "projects");
  try {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) {
        continue;
      }
      const candidate = join(root, project.name, "worktrees", input.aoSessionId);
      if (await fileExists(candidate)) {
        return { path: normalize(candidate), discoveredVia: "fallback" };
      }
    }
  } catch {
    return {};
  }
  return {};
}

async function findGitWorktree(
  projectRoot: string,
  aoSessionId: string
): Promise<string | undefined> {
  try {
    const result = await execa("git", ["-C", projectRoot, "worktree", "list", "--porcelain"]);
    const entries = parseGitWorktreeList(result.stdout);
    return entries.find(
      (entry) =>
        entry.branch === `refs/heads/session/${aoSessionId}` ||
        entry.branch === `session/${aoSessionId}` ||
        basename(entry.worktree) === aoSessionId
    )?.worktree;
  } catch {
    return undefined;
  }
}

function parseGitWorktreeList(stdout: string): Array<{ worktree: string; branch?: string }> {
  const entries: Array<{ worktree: string; branch?: string }> = [];
  let current: { worktree: string; branch?: string } | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { worktree: normalize(line.slice("worktree ".length)) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

async function resolveCandidatePaths(input: {
  contract?: ArtifactContract;
  worktreePath: string;
  workflowId: string;
  relativeOutput: string;
  targetPath: string;
  taskId: string;
  kind: string;
}): Promise<Array<{ path: string; source?: string; priority?: number }>> {
  if (input.contract) {
    const rawCandidates = input.contract.candidatePaths
      .filter((candidate) => candidate.relativeTo === "worktree")
      .flatMap(buildCandidatePathVariants)
      .sort((left, right) => right.priority - left.priority);
    const candidates = await Promise.all(rawCandidates.map(async (candidate) => {
      const exactPath = normalize(
        resolve(input.worktreePath, candidate.file.replaceAll("{workflowId}", input.workflowId))
      );
      return {
        path: await resolveCaseAwarePath(
          exactPath,
          input.contract?.pathCaseSensitivity ?? defaultPathCaseSensitivity()
        ),
        source: candidate.source,
        priority: candidate.priority
      };
    }));
    return uniqueCandidatePaths(candidates, input.contract.pathCaseSensitivity);
  }
  return [
    {
      path: normalize(
        resolve(input.worktreePath, ".ao-control-plane", input.workflowId, input.relativeOutput)
      ),
      source: "worktree_control_plane",
      priority: 90
    }
  ];
}

function uniqueCandidatePaths(
  candidates: Array<{ path: string; source?: string; priority?: number }>,
  pathCaseSensitivity?: ArtifactContract["pathCaseSensitivity"]
): Array<{ path: string; source?: string; priority?: number }> {
  const seen = new Set<string>();
  const caseSensitivity = pathCaseSensitivity ?? defaultPathCaseSensitivity();
  return candidates.filter((candidate) => {
    const key =
      caseSensitivity === "case_insensitive" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function defaultPathCaseSensitivity(): "case_insensitive" | "case_sensitive" {
  return process.platform === "win32" || process.platform === "darwin"
    ? "case_insensitive"
    : "case_sensitive";
}

async function resolveCaseAwarePath(
  exactPath: string,
  pathCaseSensitivity: "case_insensitive" | "case_sensitive"
): Promise<string> {
  if (pathCaseSensitivity === "case_sensitive") {
    return exactPath;
  }
  const root = resolve(parsePathRoot(exactPath));
  const relativeParts = relative(root, exactPath).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return exactPath;
    }
    const matched = entries.find((entry) => entry.name.toLowerCase() === part.toLowerCase());
    if (!matched) {
      return exactPath;
    }
    current = join(current, matched.name);
  }
  return normalize(current);
}

function parsePathRoot(pathValue: string): string {
  const resolved = resolve(pathValue);
  const parsed = resolved.match(/^[A-Za-z]:[\\/]/)?.[0];
  return parsed ?? sep;
}

function candidateMatchesContentType(contract: ArtifactContract, candidatePath: string): boolean {
  if (contract.contentType === "json") {
    return candidatePath.endsWith(".json");
  }
  if (contract.contentType === "markdown") {
    return candidatePath.endsWith(".md") || candidatePath.endsWith(".markdown");
  }
  if (contract.contentType === "flag") {
    return candidatePath.endsWith(".flag");
  }
  return true;
}

async function readGitBranch(worktreePath: string): Promise<string | undefined> {
  try {
    const result = await execa("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function isCleanGitWorktree(worktreePath: string): Promise<boolean> {
  try {
    const result = await execa("git", ["-C", worktreePath, "status", "--porcelain"]);
    return result.stdout.trim().length === 0;
  } catch {
    return false;
  }
}

async function validateCandidateSize(
  kind: string,
  candidatePath: string
): Promise<ReconcileFailure | undefined> {
  const fileStat = await stat(candidatePath);
  const limit = candidatePath.endsWith(".json")
    ? jsonSizeLimitBytes
    : isFlagArtifactKind(kind)
      ? flagSizeLimitBytes
      : undefined;
  if (limit !== undefined && fileStat.size > limit) {
    return {
      kind,
      path: candidatePath,
      reason: "size_exceeded",
      detail: `candidate exceeds ${limit} bytes`
    };
  }
  return undefined;
}

async function atomicWriteText(file: string, value: string): Promise<void> {
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmpFile, value, "utf8");
  try {
    await rename(tmpFile, file);
  } catch (error) {
    await rm(tmpFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function rollbackFiles(paths: string[]): Promise<{ rolledBack: string[]; failed: string[] }> {
  const rolledBack: string[] = [];
  const failed: string[] = [];
  for (const file of paths) {
    try {
      await rm(file, { force: true });
      rolledBack.push(file);
    } catch {
      failed.push(file);
    }
  }
  return { rolledBack, failed };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function safeRelative(root: string, target: string): string | undefined {
  const normalizedRoot = normalize(resolve(root));
  const normalizedTarget = normalize(isAbsolute(target) ? target : resolve(root, target));
  const value = relative(normalizedRoot, normalizedTarget);
  if (!value || value.startsWith("..") || isAbsolute(value)) {
    return undefined;
  }
  return value;
}

function isPathInside(pathValue: string, rootValue: string): boolean {
  const root = normalize(resolve(rootValue));
  const candidate = normalize(resolve(pathValue));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparablePrefix = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;
  const comparableCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  return comparableCandidate === comparableRoot || comparableCandidate.startsWith(comparablePrefix);
}

function hasAoReviewSourceProof(json: Record<string, unknown>, aoSessionId: string): boolean {
  const fields = readReviewerSourceFields(json);
  if (fields.source === "ao_review") {
    return !fields.aoSessionId || fields.aoSessionId === aoSessionId;
  }
  if (fields.source !== "control_plane_manual_gate") {
    return false;
  }
  if (fields.decidedBy?.includes(aoSessionId)) {
    return true;
  }
  if (fields.reviewerSessionId === aoSessionId) {
    return true;
  }
  return fields.reviewerIndependence?.reviewerSessionId === aoSessionId;
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

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isClosedOrMerged(session: AoSessionSnapshot): boolean {
  const values = [session.status, session.reviewStatus, session.ciStatus]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return values.includes("merged") || values.includes("closed");
}

function createEmptyResult(): ArtifactReconcileResult {
  return {
    recovered: [],
    skipped: [],
    conflicts: [],
    missing: [],
    failures: []
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function validateRecoveredTaskOutputs(input: {
  task: ExecutionTask;
  artifactDir: string;
  manualGateMode?: "manual_approve" | "ao_review";
  aoSessionId?: string;
}): Promise<{
  conflicts: ConflictArtifact[];
  missing: Awaited<ReturnType<typeof validateTaskOutputArtifacts>>["missingArtifacts"];
}> {
  const validation = await validateTaskOutputArtifacts(input);
  return {
    conflicts: validation.conflictArtifacts,
    missing: validation.missingArtifacts
  };
}
