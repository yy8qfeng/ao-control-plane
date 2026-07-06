import { basename, dirname, join, normalize } from "node:path";
import { taskTypeSchema, type ExecutionTask, type TaskArtifact, type TaskPlan } from "../schemas/task-plan.js";

export type ArtifactContentType = "json" | "flag" | "markdown" | "text";
export type ArtifactCandidateSource =
  "canonical" | "worktree_control_plane" | "worktree_mirror" | "legacy_alias";
export type ArtifactCandidatePurpose = "primary" | "mirror" | "legacy_alias";
export type ArtifactCandidateRelativeTo = "artifactDir" | "worktree" | "projectRoot";
export type ArtifactCompletionCheck =
  | "exists"
  | "valid-json"
  | "ownership-fields"
  | "markdown-header"
  | "flag-kv"
  | "case-insensitive-match";

export interface ArtifactCandidatePath {
  file: string;
  priority: number;
  source: ArtifactCandidateSource;
  relativeTo: ArtifactCandidateRelativeTo;
  purpose: ArtifactCandidatePurpose;
}

export interface ArtifactOwnershipContract {
  requiredFields: Array<"workflowId" | "taskId">;
  sessionField?: "aoSessionId" | "producedBySessionId" | "reviewerSessionId";
  allowMissingSessionForNonGateJson?: boolean;
}

export interface ArtifactMarkdownOwnershipContract {
  required: boolean;
  markerPattern: string;
  searchWindowLines: number;
}

export interface ArtifactFlagOwnershipContract {
  required: boolean;
  fields: Array<"workflowId" | "taskId" | "aoSessionId">;
  format: "kv" | "json";
}

export interface ArtifactJsonSchemaContract {
  requiredFields?: string[];
}

export interface ArtifactContract {
  id: string;
  kind: string;
  canonicalFile: string;
  required: boolean;
  requiredWhen?: string;
  contentType: ArtifactContentType;
  producer: {
    taskMatcher: RegExp;
    taskType?: Array<ExecutionTask["type"]>;
    dependencyCondition?: ExecutionTask["dependencyCondition"];
    expectedPlanVersion?: "task-plan-current" | `task-plan-v${number}`;
  };
  candidatePaths: ArtifactCandidatePath[];
  jsonSchema?: ArtifactJsonSchemaContract;
  ownership: ArtifactOwnershipContract;
  markdownOwnership?: ArtifactMarkdownOwnershipContract;
  flagOwnership?: ArtifactFlagOwnershipContract;
  pathCaseSensitivity?: "case_insensitive" | "case_sensitive";
}

export interface ArtifactRegistryIssue {
  id: string;
  message: string;
  severity: "blocking" | "warning";
}

export class ArtifactContractRegistry {
  private readonly contractsById = new Map<string, ArtifactContract>();
  private readonly contractsByKind = new Map<string, ArtifactContract>();
  private readonly contractsByCanonicalFile = new Map<string, ArtifactContract>();
  private readonly contractsByFileName = new Map<string, ArtifactContract[]>();

  constructor(readonly contracts: ArtifactContract[]) {
    for (const contract of contracts) {
      this.contractsById.set(contract.id, contract);
      this.contractsByKind.set(contract.kind, contract);
      this.contractsByCanonicalFile.set(normalizeFileKey(contract.canonicalFile), contract);
      for (const candidate of contract.candidatePaths) {
        const key = normalizeFileKey(basename(candidate.file));
        this.contractsByFileName.set(key, [...(this.contractsByFileName.get(key) ?? []), contract]);
      }
    }
  }

  getAll(): ArtifactContract[] {
    return [...this.contracts];
  }

  findById(id: string | undefined): ArtifactContract | undefined {
    return id ? this.contractsById.get(id) : undefined;
  }

  findByKind(kind: string | undefined): ArtifactContract | undefined {
    return kind ? this.contractsByKind.get(kind) : undefined;
  }

  findByCanonicalFile(file: string | undefined): ArtifactContract | undefined {
    return file ? this.contractsByCanonicalFile.get(normalizeFileKey(file)) : undefined;
  }

  findContractByFileName(fileName: string): ArtifactContract[] {
    return [...(this.contractsByFileName.get(normalizeFileKey(fileName)) ?? [])];
  }

  findContractsForTask(
    task: ExecutionTask,
    activePlanVersion: "task-plan-current" | `task-plan-v${number}` = "task-plan-current"
  ): ArtifactContract[] {
    const text = taskText(task);
    return this.contracts.filter(
      (contract) =>
        isContractActiveForPlanVersion(contract, activePlanVersion) &&
        (!contract.producer.taskType || contract.producer.taskType.includes(task.type)) &&
        (!contract.producer.dependencyCondition ||
          contract.producer.dependencyCondition === task.dependencyCondition) &&
        regexMatches(contract.producer.taskMatcher, text)
    );
  }

  resolveContractForArtifact(
    artifact: Pick<TaskArtifact, "contractId" | "kind" | "path">
  ): ArtifactContract | undefined {
    return (
      this.findById(artifact.contractId) ??
      this.findByKind(artifact.kind) ??
      this.findByCanonicalFile(artifact.path)
    );
  }

  toTaskArtifact(contract: ArtifactContract, taskId?: string): TaskArtifact {
    return {
      ...(taskId ? { taskId } : {}),
      contractId: contract.id,
      kind: contract.kind,
      path: contract.canonicalFile,
      required: contract.required,
      ...(contract.requiredWhen ? { requiredWhen: contract.requiredWhen } : {})
    };
  }

  deriveManualGateTemplates(): Array<{
    gateId: string;
    match: RegExp;
    input?: { kind: string; file: string; required?: boolean; requiredWhen?: string };
    decision: { kind: string; file: string; required?: boolean; requiredWhen?: string };
    flag: { kind: string; file: string; required?: boolean; requiredWhen?: string };
    rework?: { kind: string; file: string; required?: boolean; requiredWhen?: string };
  }> {
    return manualGateGroups.map((group) => {
      const decision = requiredContract(this, group.decision);
      const flag = requiredContract(this, group.flag);
      const rework = this.findById(group.rework);
      const inputContractId = "input" in group ? group.input : undefined;
      const input = inputContractId ? this.findById(inputContractId) : undefined;
      return {
        gateId: group.gateId,
        match: group.match,
        ...(input ? { input: toTemplateArtifact(input) } : {}),
        decision: toTemplateArtifact(decision),
        flag: toTemplateArtifact(flag),
        ...(rework ? { rework: toTemplateArtifact(rework) } : {})
      };
    });
  }

  deriveTaskOutputTemplates(): Array<{
    match: RegExp;
    artifacts: Array<{ kind: string; file: string; required?: boolean; requiredWhen?: string }>;
  }> {
    return taskOutputGroups.map((group) => ({
      match: group.match,
      artifacts: group.contractIds.map((id) => toTemplateArtifact(requiredContract(this, id)))
    }));
  }

  validate(
    plan?: TaskPlan,
    activePlanVersion: "task-plan-current" | `task-plan-v${number}` = "task-plan-current"
  ): ArtifactRegistryIssue[] {
    const issues: ArtifactRegistryIssue[] = [];
    const seenIds = new Set<string>();
    const seenKinds = new Set<string>();
    const seenFiles = new Set<string>();
    const seenCandidateRoutes = new Map<string, ArtifactContract>();
    const knownTaskTypes = new Set(taskTypeSchema.options);
    for (const contract of this.contracts) {
      addUniqueIssue(issues, seenIds, contract.id, `duplicate contract id ${contract.id}`);
      addUniqueIssue(issues, seenKinds, contract.kind, `duplicate contract kind ${contract.kind}`);
      addUniqueIssue(
        issues,
        seenFiles,
        normalizeFileKey(contract.canonicalFile),
        `duplicate canonicalFile ${contract.canonicalFile}`
      );
      if (contract.canonicalFile !== contract.canonicalFile.toLowerCase()) {
        issues.push({
          id: `canonical-case-${contract.id}`,
          severity: "blocking",
          message: `${contract.id} canonicalFile must be lowercase`
        });
      }
      if (!contract.candidatePaths.some((candidate) => candidate.source === "canonical")) {
        issues.push({
          id: `canonical-candidate-${contract.id}`,
          severity: "blocking",
          message: `${contract.id} must declare canonical candidate`
        });
      }
      if (contract.producer.taskMatcher.flags.includes("g")) {
        issues.push({
          id: `task-matcher-global-${contract.id}`,
          severity: "blocking",
          message: `${contract.id} taskMatcher must not use the g flag`
        });
      }
      for (const taskType of contract.producer.taskType ?? []) {
        if (!knownTaskTypes.has(taskType)) {
          issues.push({
            id: `task-type-${contract.id}-${taskType}`,
            severity: "blocking",
            message: `${contract.id} uses unsupported taskType ${taskType}`
          });
        }
      }
      if (contract.requiredWhen && evaluateRequiredWhenSyntax(contract.requiredWhen) === false) {
        issues.push({
          id: `required-when-${contract.id}`,
          severity: "blocking",
          message: `${contract.id} requiredWhen is not supported: ${contract.requiredWhen}`
        });
      }
      const candidateFileNames = new Set<string>();
      for (const candidate of contract.candidatePaths) {
        const candidateFileName = basename(candidate.file);
        const candidateKey = `${candidate.relativeTo}:${candidate.source}:${normalizeFileKey(candidate.file)}`;
        const previousCandidateOwner = seenCandidateRoutes.get(candidateKey);
        if (previousCandidateOwner && previousCandidateOwner.id !== contract.id) {
          issues.push({
            id: `candidate-route-conflict-${candidateKey}`,
            severity: "blocking",
            message: `${contract.id} and ${previousCandidateOwner.id} declare the same candidate route ${candidateKey}`
          });
        }
        seenCandidateRoutes.set(candidateKey, contract);
        if (candidateFileNames.has(candidateKey)) {
          issues.push({
            id: `candidate-duplicate-filename-${contract.id}-${candidateKey}`,
            severity: "blocking",
            message: `${contract.id} declares duplicate candidate filename ${candidateFileName}`
          });
        }
        candidateFileNames.add(candidateKey);
        const expectedPurpose: ArtifactCandidatePurpose =
          candidate.source === "canonical" || candidate.source === "worktree_control_plane"
            ? "primary"
            : candidate.source === "worktree_mirror"
              ? "mirror"
              : "legacy_alias";
        if (candidate.purpose !== expectedPurpose) {
          issues.push({
            id: `candidate-purpose-${contract.id}`,
            severity: "blocking",
            message: `${contract.id} candidate source/purpose mismatch`
          });
        }
        if (
          candidate.relativeTo === "projectRoot" &&
          !isAllowedProjectRootCandidate(candidate.file)
        ) {
          issues.push({
            id: `project-root-candidate-${contract.id}`,
            severity: "blocking",
            message: `${contract.id} projectRoot candidate is outside controlled prefixes`
          });
        }
      }
      if (contract.pathCaseSensitivity === "case_sensitive") {
        const lowerCaseNames = new Set<string>();
        for (const candidate of contract.candidatePaths) {
          const lower = basename(candidate.file).toLowerCase();
          if (lowerCaseNames.has(lower)) {
            issues.push({
              id: `case-sensitive-candidate-${contract.id}-${lower}`,
              severity: "blocking",
              message: `${contract.id} has case-sensitive candidate filename collision ${lower}`
            });
          }
          lowerCaseNames.add(lower);
        }
      }
      const hasProjectRootControlPlane = contract.candidatePaths.some(
        (candidate) =>
          candidate.relativeTo === "projectRoot" &&
          normalizeFileKey(candidate.file).startsWith(".ao-control-plane/")
      );
      const hasArtifactDirCandidate = contract.candidatePaths.some(
        (candidate) => candidate.relativeTo === "artifactDir"
      );
      if (hasProjectRootControlPlane && hasArtifactDirCandidate) {
        issues.push({
          id: `relativeTo-mutually-exclusive-${contract.id}`,
          severity: "blocking",
          message: `${contract.id} declares both projectRoot/.ao-control-plane and artifactDir candidates`
        });
      }
      if (contract.required && contract.contentType === "json") {
        for (const field of ["workflowId", "taskId"] as const) {
          if (!contract.ownership.requiredFields.includes(field)) {
            issues.push({
              id: `json-ownership-${contract.id}-${field}`,
              severity: "blocking",
              message: `${contract.id} required JSON must require ${field}`
            });
          }
        }
      }
      if (contract.contentType === "flag" && !contract.flagOwnership) {
        issues.push({
          id: `flag-ownership-${contract.id}`,
          severity: "blocking",
          message: `${contract.id} flag contract must declare flagOwnership`
        });
      }
    }
    if (plan) {
      const triggeredContracts = new Set<string>();
      const requiredOutputClaims = new Map<string, ExecutionTask[]>();
      for (const task of plan.tasks) {
        for (const contract of this.findContractsForTask(task, activePlanVersion)) {
          triggeredContracts.add(contract.id);
        }
        for (const artifact of task.outputArtifacts ?? []) {
          const contract = this.resolveContractForArtifact(artifact);
          if (!contract) {
            issues.push({
              id: `plan-output-${task.taskId}-${artifact.kind}`,
              severity: "warning",
              message: `${task.taskId} output artifact ${artifact.kind} has no registered contract`
            });
            continue;
          }
          if (artifact.required || contract.required) {
            const key = normalizeFileKey(contract.canonicalFile);
            requiredOutputClaims.set(key, [...(requiredOutputClaims.get(key) ?? []), task]);
          }
        }
      }
      for (const contract of this.contracts) {
        if (
          isContractActiveForPlanVersion(contract, activePlanVersion) &&
          !contract.producer.expectedPlanVersion &&
          !triggeredContracts.has(contract.id) &&
          (contract.required || contract.requiredWhen)
        ) {
          issues.push({
            id: `contract-unmatched-${contract.id}`,
            severity: "warning",
            message: `${contract.id} does not match any active plan task`
          });
        }
      }
      for (const [file, tasks] of requiredOutputClaims.entries()) {
        const uniqueTaskIds = [...new Set(tasks.map((task) => task.taskId))];
        if (uniqueTaskIds.length <= 1) {
          continue;
        }
        const allManualGate = tasks.every((task) => task.dependencyCondition === "manual_gate");
        if (!allManualGate) {
          issues.push({
            id: `required-output-duplicate-${file}`,
            severity: "blocking",
            message: `${file} is required by multiple non-manual_gate tasks: ${uniqueTaskIds.join(", ")}`
          });
        }
      }
      for (const task of plan.tasks.filter((item) => item.dependencyCondition === "manual_gate")) {
        const flags = (task.outputArtifacts ?? []).filter((artifact) => /flag|approved/i.test(artifact.kind));
        for (const flag of flags) {
          const consumed = plan.tasks.some((candidate) => {
            if (candidate.taskId === task.taskId) {
              return false;
            }
            const text = taskText(candidate);
            return text.includes(flag.path) || text.includes(flag.kind);
          });
          if (!consumed) {
            issues.push({
              id: `gate-without-consumer-${task.taskId}-${flag.kind}`,
              severity: "warning",
              message: `${task.taskId} produces ${flag.kind} but no downstream task references it`
            });
          }
        }
      }
    }
    return issues;
  }
}

export function getArtifactContractRegistry(): ArtifactContractRegistry {
  return registry;
}

export function buildCandidatePathVariants(
  candidate: ArtifactCandidatePath
): ArtifactCandidatePath[] {
  const fileName = basename(candidate.file);
  const variants = new Set<string>([fileName]);
  if (fileName.includes("_")) {
    variants.add(fileName.replace(/_/g, "-"));
  }
  if (fileName.includes("-")) {
    variants.add(fileName.replace(/-/g, "_"));
  }
  return [...variants].map((variant) => ({
    ...candidate,
    file: join(dirname(candidate.file), variant)
  }));
}

export function serializeTaskMatcher(regex: RegExp): string {
  return `/${regex.source}/${regex.flags}`;
}

export function getRequiredJsonFields(contract: ArtifactContract): string[] {
  return [...new Set([...(contract.jsonSchema?.requiredFields ?? []), ...contract.ownership.requiredFields])];
}

export function getCandidatePaths(
  contract: ArtifactContract,
  context: { artifactDir: string; worktreePath?: string; projectRoot?: string; workflowId: string }
): Array<ArtifactCandidatePath & { absolutePath: string }> {
  return contract.candidatePaths.map((candidate) => {
    const file = candidate.file.replaceAll("{workflowId}", context.workflowId);
    const root =
      candidate.relativeTo === "artifactDir"
        ? context.artifactDir
        : candidate.relativeTo === "projectRoot"
          ? (context.projectRoot ?? context.artifactDir)
          : (context.worktreePath ?? context.artifactDir);
    return {
      ...candidate,
      file,
      absolutePath: normalize(join(root, file))
    };
  });
}

export function getCompletionChecks(contract: ArtifactContract): ArtifactCompletionCheck[] {
  return [
    "exists",
    ...(contract.contentType === "json" ? (["valid-json", "ownership-fields"] as const) : []),
    ...(contract.contentType === "markdown" ? (["markdown-header"] as const) : []),
    ...(contract.contentType === "flag" ? (["flag-kv"] as const) : [])
  ];
}

function makeContract(
  input: Omit<ArtifactContract, "candidatePaths" | "ownership"> & {
    mirrors?: string[];
    legacyAliases?: string[];
    ownership?: ArtifactOwnershipContract;
  }
): ArtifactContract {
  const ownership = input.ownership ?? {
    requiredFields: input.contentType === "json" ? ["workflowId", "taskId"] : []
  };
  const candidatePaths: ArtifactCandidatePath[] = [
    {
      source: "canonical",
      relativeTo: "artifactDir",
      file: input.canonicalFile,
      priority: 100,
      purpose: "primary"
    },
    {
      source: "worktree_control_plane",
      relativeTo: "worktree",
      file: `.ao-control-plane/{workflowId}/${input.canonicalFile}`,
      priority: 90,
      purpose: "primary"
    },
    ...(input.mirrors ?? []).map((file, index) => ({
      source: "worktree_mirror" as const,
      relativeTo: "worktree" as const,
      file,
      priority: 80 - index,
      purpose: "mirror" as const
    })),
    ...(input.legacyAliases ?? []).map((file, index) => ({
      source: "legacy_alias" as const,
      relativeTo: "worktree" as const,
      file,
      priority: 60 - index,
      purpose: "legacy_alias" as const
    }))
  ];
  return {
    ...input,
    ownership,
    candidatePaths
  };
}

function jsonContract(
  id: string,
  canonicalFile: string,
  matcher: RegExp,
  options: {
    required?: boolean;
    requiredWhen?: string;
    taskType?: ArtifactContract["producer"]["taskType"];
    dependencyCondition?: ExecutionTask["dependencyCondition"];
    mirrors?: string[];
    legacyAliases?: string[];
    sessionField?: ArtifactOwnershipContract["sessionField"];
  } = {}
): ArtifactContract {
  return makeContract({
    id,
    kind: id,
    canonicalFile,
    required: options.required ?? true,
    requiredWhen: options.requiredWhen,
    contentType: "json",
    producer: {
      taskMatcher: matcher,
      taskType: options.taskType,
      dependencyCondition: options.dependencyCondition
    },
    mirrors: options.mirrors,
    legacyAliases: options.legacyAliases,
    jsonSchema: { requiredFields: ["workflowId", "taskId"] },
    ownership: {
      requiredFields: ["workflowId", "taskId"],
      sessionField: options.sessionField,
      allowMissingSessionForNonGateJson: true
    }
  });
}

function markdownContract(
  id: string,
  canonicalFile: string,
  matcher: RegExp,
  options: {
    required?: boolean;
    mirrors?: string[];
    legacyAliases?: string[];
  } = {}
): ArtifactContract {
  return makeContract({
    id,
    kind: id,
    canonicalFile,
    required: options.required ?? false,
    contentType: "markdown",
    producer: { taskMatcher: matcher },
    mirrors: options.mirrors,
    legacyAliases: options.legacyAliases,
    ownership: { requiredFields: [] },
    markdownOwnership: {
      required: false,
      markerPattern: "workflowId|taskId",
      searchWindowLines: 20
    }
  });
}

function flagContract(
  id: string,
  canonicalFile: string,
  matcher: RegExp,
  requiredWhen: string
): ArtifactContract {
  return makeContract({
    id,
    kind: id,
    canonicalFile,
    required: false,
    requiredWhen,
    contentType: "flag",
    producer: {
      taskMatcher: matcher,
      dependencyCondition: "manual_gate"
    },
    ownership: { requiredFields: [] },
    flagOwnership: {
      required: false,
      fields: ["workflowId", "taskId", "aoSessionId"],
      format: "kv"
    }
  });
}

const g0Matcher = /G0.*人工复核放行|人工复核放行/i;
const ipcGateMatcher = /IPC.*契约.*人工复核门禁|跨语言 IPC 契约人工复核门禁/i;
const transportGateMatcher =
  /共享传输抽象契约人工复核门禁|transport_contract.*(?:manual_gate|review_gate)/i;
const outboundGateMatcher =
  /OutboundTransport.*契约人工复核门禁|发送契约人工复核门禁|outbound_contract.*(?:manual_gate|review_gate)/i;
const sharedBoundaryGateMatcher =
  /共享文件边界.*人工门禁|shared_boundary.*(?:manual_gate|review_gate)/i;
const platformGateMatcher =
  /平台适配器.*人工复核门禁|platform_adapter.*(?:manual_gate|review_gate)/i;
const jarGateMatcher =
  /JAR.*契约人工复核门禁|JAR 公开 API.*人工复核门禁|jar_api_contract.*(?:manual_gate|review_gate)/i;
const linuxGateMatcher =
  /Linux.*(?:私有|后端).*契约.*人工复核|linux_backend.*(?:manual_gate|review_gate)/i;
const windowsGateMatcher =
  /Windows.*(?:IOCP|私有|后端).*契约.*人工复核|windows_iocp.*(?:manual_gate|review_gate)/i;
const macosGateMatcher =
  /macOS.*(?:kqueue|私有|后端).*契约.*人工复核|macos_kqueue.*(?:manual_gate|review_gate)/i;
const ipcMainPathGateMatcher = /IPC.*主路径.*人工复核|ipc_main_path.*(?:manual_gate|review_gate)/i;
const releaseGateMatcher = /最终发布人工复核门禁|release.*(?:manual_gate|review_gate)/i;

const taskOutputGroups = [
  { match: /仓库现实校准/i, contractIds: ["g0_repo_reality_check"] },
  {
    match: /治理门禁决策文件|gate 文件|回流规范/i,
    contractIds: [
      "gate_governance_freeze",
      "gate_governance_freeze_markdown",
      "gate_decision_schema",
      "qa_verdict"
    ]
  },
  {
    match: /跨语言 IPC 核心字节布局契约/i,
    contractIds: [
      "ipc_byte_layout_freeze",
      "ipc_byte_layout_freeze_markdown",
      "ipc_byte_layout_qa_verdict"
    ]
  },
  {
    match: /IPC.*容量边界|容量边界.*IPC|共享段容量/i,
    contractIds: ["ipc_capacity_boundary_freeze", "ipc_capacity_boundary_freeze_markdown"]
  },
  {
    match: /共享传输抽象与平台边界/i,
    contractIds: ["transport_contract_freeze", "transport_contract_freeze_markdown"]
  },
  {
    match: /OutboundTransport.*发送契约/i,
    contractIds: ["outbound_contract_freeze", "outbound_contract_freeze_markdown"]
  },
  { match: /跨平台后端特性矩阵与共享夹具契约/i, contractIds: ["shared_boundary_manifest"] },
  { match: /平台适配器统一接口与状态映射契约/i, contractIds: ["platform_adapter_contract"] },
  { match: /JDK 21 JAR 公开 API 与示例依赖契约/i, contractIds: ["jar_api_contract_freeze"] },
  { match: /统一发布前 QA verdict 汇总裁决/i, contractIds: ["unified_qa_verdict"] },
  { match: /统一 QA verdict 失败回流重规划/i, contractIds: ["qa_verdict_rework_request"] },
  { match: /发布二进制候选产物归档/i, contractIds: ["release_binary_archive"] },
  { match: /发布文档与证据索引归档/i, contractIds: ["release_docs_evidence_archive"] },
  { match: /回滚预案与回滚验证入口/i, contractIds: ["rollback_plan"] },
  { match: /发布驳回回流重规划/i, contractIds: ["release_rework_request"] },
  { match: /planning gate|task plan gate|任务计划.*门禁|计划.*审批/i, contractIds: ["task_plan_approval_report"] },
  { match: /contract freeze|契约冻结/i, contractIds: ["contract_freeze_evidence"] },
  { match: /release decision|发布.*决策文件/i, contractIds: ["release_decision"] }
] as const;

const manualGateGroups = [
  {
    gateId: "g0",
    match: g0Matcher,
    input: "g0_repo_reality_check",
    decision: "g0_review_gate_decision",
    flag: "g0_approved_flag",
    rework: "g0_replan_request"
  },
  {
    gateId: "ipc_contract",
    match: ipcGateMatcher,
    decision: "ipc_contract_review_gate_decision",
    flag: "ipc_contract_approved_flag",
    rework: "ipc_contract_rework_request"
  },
  {
    gateId: "transport_contract",
    match: transportGateMatcher,
    decision: "transport_contract_review_gate_decision",
    flag: "transport_contract_approved_flag",
    rework: "transport_contract_rework_request"
  },
  {
    gateId: "outbound_contract",
    match: outboundGateMatcher,
    decision: "outbound_contract_review_gate_decision",
    flag: "outbound_contract_approved_flag",
    rework: "outbound_contract_rework_request"
  },
  {
    gateId: "shared_boundary",
    match: sharedBoundaryGateMatcher,
    decision: "shared_boundary_review_gate_decision",
    flag: "shared_boundary_approved_flag",
    rework: "shared_boundary_rework_request"
  },
  {
    gateId: "platform_adapter",
    match: platformGateMatcher,
    decision: "platform_adapter_review_gate_decision",
    flag: "platform_adapter_approved_flag",
    rework: "platform_adapter_rework_request"
  },
  {
    gateId: "jar_api_contract",
    match: jarGateMatcher,
    decision: "jar_api_contract_review_gate_decision",
    flag: "jar_api_contract_approved_flag",
    rework: "jar_api_contract_rework_request"
  },
  {
    gateId: "linux_backend",
    match: linuxGateMatcher,
    decision: "linux_backend_contract_review_gate_decision",
    flag: "linux_backend_contract_approved_flag",
    rework: "linux_backend_contract_rework_request"
  },
  {
    gateId: "windows_iocp",
    match: windowsGateMatcher,
    decision: "windows_iocp_contract_review_gate_decision",
    flag: "windows_iocp_contract_approved_flag",
    rework: "windows_iocp_contract_rework_request"
  },
  {
    gateId: "macos_kqueue",
    match: macosGateMatcher,
    decision: "macos_kqueue_contract_review_gate_decision",
    flag: "macos_kqueue_contract_approved_flag",
    rework: "macos_kqueue_contract_rework_request"
  },
  {
    gateId: "ipc_main_path",
    match: ipcMainPathGateMatcher,
    decision: "ipc_main_path_review_gate_decision",
    flag: "ipc_main_path_review_approved_flag",
    rework: "ipc_main_path_review_rework_request"
  },
  {
    gateId: "release",
    match: releaseGateMatcher,
    decision: "release_review_gate_decision",
    flag: "release_approved_flag",
    rework: "release_rework_request"
  }
] as const;

const contracts: ArtifactContract[] = [
  jsonContract("task_plan_approval_report", "task-plan-approval-report.json", /planning gate|task plan gate|任务计划.*门禁|计划.*审批/i),
  jsonContract("contract_freeze_evidence", "contract-freeze-evidence.json", /(^|\n)contract freeze|contract-freeze-evidence/i),
  jsonContract("release_decision", "release_decision.json", /release decision|发布.*决策文件/i),
  jsonContract("g0_repo_reality_check", "g0_repo_reality_check.json", /仓库现实校准/i),
  jsonContract("g0_review_gate_decision", "g0_review_gate_decision.json", g0Matcher, {
    dependencyCondition: "manual_gate",
    sessionField: "aoSessionId"
  }),
  flagContract("g0_approved_flag", "g0_approved.flag", g0Matcher, "decision=approved"),
  jsonContract("g0_replan_request", "g0_replan_request.json", /G0.*复核失败回流|复核失败回流/i, {
    required: false,
    requiredWhen: "decision=rework_required"
  }),

  jsonContract(
    "gate_governance_freeze",
    "gate_governance_freeze.json",
    /治理门禁决策文件|gate 文件|回流规范/i
  ),
  markdownContract(
    "gate_governance_freeze_markdown",
    "gate_governance_freeze.md",
    /治理门禁决策文件|gate 文件|回流规范/i,
    { required: true }
  ),
  jsonContract(
    "gate_decision_schema",
    "gate_decision_schema.json",
    /治理门禁决策文件|gate 文件|回流规范/i
  ),
  jsonContract(
    "qa_verdict",
    "qa_verdict.json",
    /治理门禁决策文件|gate 文件|回流规范|(^|\n)(QA verdict|Write QA verdict)|产出\s*qa_verdict\.json/i
  ),

  jsonContract(
    "ipc_byte_layout_freeze",
    "ipc_byte_layout_freeze.json",
    /跨语言 IPC 核心字节布局契约/i,
    {
      mirrors: ["docs/ipc/ipc-byte-layout-freeze.json"],
      legacyAliases: ["docs/ipc/ipc_byte_layout_freeze.json"]
    }
  ),
  markdownContract(
    "ipc_byte_layout_freeze_markdown",
    "ipc_byte_layout_freeze.md",
    /跨语言 IPC 核心字节布局契约/i,
    {
      required: true,
      mirrors: ["docs/ipc/ipc-byte-layout-freeze.md"]
    }
  ),
  jsonContract(
    "ipc_byte_layout_qa_verdict",
    "ipc_byte_layout_qa_verdict.json",
    /跨语言 IPC 核心字节布局契约/i
  ),
  jsonContract(
    "ipc_capacity_boundary_freeze",
    "ipc_capacity_boundary_freeze.json",
    /IPC.*容量边界|容量边界.*IPC|共享段容量/i,
    {
      mirrors: ["docs/ipc/ipc-capacity-boundary-freeze.json"]
    }
  ),
  markdownContract(
    "ipc_capacity_boundary_freeze_markdown",
    "ipc_capacity_boundary_freeze.md",
    /IPC.*容量边界|容量边界.*IPC|共享段容量/i,
    {
      mirrors: ["docs/ipc/ipc-capacity-boundary-freeze.md"]
    }
  ),

  jsonContract(
    "ipc_contract_review_gate_decision",
    "ipc_contract_review_gate_decision.json",
    ipcGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "ipc_contract_approved_flag",
    "ipc_contract_approved.flag",
    ipcGateMatcher,
    "decision=approved"
  ),
  jsonContract("ipc_contract_rework_request", "ipc_contract_rework_request.json", ipcGateMatcher, {
    required: false,
    requiredWhen: "decision=rework_required"
  }),

  jsonContract(
    "transport_contract_freeze",
    "transport_contract_freeze.json",
    /共享传输抽象与平台边界/i,
    {
      mirrors: ["docs/transport/transport-contract-freeze.json"],
      legacyAliases: ["docs/transport/transport_contract_freeze.json"]
    }
  ),
  markdownContract(
    "transport_contract_freeze_markdown",
    "transport_contract_freeze.md",
    /共享传输抽象与平台边界/i,
    {
      mirrors: ["docs/transport/transport-contract-freeze.md"],
      legacyAliases: ["docs/transport/transport_contract_freeze.md"]
    }
  ),
  jsonContract(
    "transport_contract_review_gate_decision",
    "transport_contract_review_gate_decision.json",
    transportGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "transport_contract_approved_flag",
    "transport_contract_approved.flag",
    transportGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "transport_contract_rework_request",
    "transport_contract_rework_request.json",
    transportGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),

  jsonContract(
    "outbound_contract_freeze",
    "outbound_contract_freeze.json",
    /OutboundTransport.*发送契约/i,
    {
      mirrors: ["docs/transport/outbound-contract-freeze.json"],
      legacyAliases: ["docs/transport/outbound_contract_freeze.json"]
    }
  ),
  markdownContract(
    "outbound_contract_freeze_markdown",
    "outbound_contract_freeze.md",
    /OutboundTransport.*发送契约/i,
    {
      mirrors: ["docs/transport/outbound-contract-freeze.md"]
    }
  ),
  jsonContract(
    "outbound_contract_review_gate_decision",
    "outbound_contract_review_gate_decision.json",
    outboundGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "outbound_contract_approved_flag",
    "outbound_contract_approved.flag",
    outboundGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "outbound_contract_rework_request",
    "outbound_contract_rework_request.json",
    outboundGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),

  jsonContract(
    "shared_boundary_manifest",
    "shared_boundary_manifest.json",
    /跨平台后端特性矩阵与共享夹具契约/i,
    {
      mirrors: ["docs/platform/shared-boundary-manifest.json"]
    }
  ),
  jsonContract(
    "shared_boundary_review_gate_decision",
    "shared_boundary_review_gate_decision.json",
    sharedBoundaryGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "shared_boundary_approved_flag",
    "shared_boundary_approved.flag",
    sharedBoundaryGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "shared_boundary_rework_request",
    "shared_boundary_rework_request.json",
    sharedBoundaryGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),

  jsonContract(
    "platform_adapter_contract",
    "platform_adapter_contract.json",
    /平台适配器统一接口与状态映射契约/i,
    {
      mirrors: ["docs/platform/platform-adapter-contract.json"]
    }
  ),
  jsonContract(
    "platform_adapter_review_gate_decision",
    "platform_adapter_review_gate_decision.json",
    platformGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "platform_adapter_approved_flag",
    "platform_adapter_approved.flag",
    platformGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "platform_adapter_rework_request",
    "platform_adapter_rework_request.json",
    platformGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),

  jsonContract(
    "jar_api_contract_freeze",
    "jar_api_contract_freeze.json",
    /JDK 21 JAR 公开 API 与示例依赖契约/i,
    {
      mirrors: ["docs/jar/jar-api-contract-freeze.json", "docs/java/jar-api-contract-freeze.json"]
    }
  ),
  jsonContract(
    "jar_api_contract_review_gate_decision",
    "jar_api_contract_review_gate_decision.json",
    jarGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "jar_api_contract_approved_flag",
    "jar_api_contract_approved.flag",
    jarGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "jar_api_contract_rework_request",
    "jar_api_contract_rework_request.json",
    jarGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),

  jsonContract(
    "linux_backend_contract_review_gate_decision",
    "linux_backend_contract_review_gate_decision.json",
    linuxGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "linux_backend_contract_approved_flag",
    "linux_backend_contract_approved.flag",
    linuxGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "linux_backend_contract_rework_request",
    "linux_backend_contract_rework_request.json",
    linuxGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),
  jsonContract(
    "windows_iocp_contract_review_gate_decision",
    "windows_iocp_contract_review_gate_decision.json",
    windowsGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "windows_iocp_contract_approved_flag",
    "windows_iocp_contract_approved.flag",
    windowsGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "windows_iocp_contract_rework_request",
    "windows_iocp_contract_rework_request.json",
    windowsGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),
  jsonContract(
    "macos_kqueue_contract_review_gate_decision",
    "macos_kqueue_contract_review_gate_decision.json",
    macosGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "macos_kqueue_contract_approved_flag",
    "macos_kqueue_contract_approved.flag",
    macosGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "macos_kqueue_contract_rework_request",
    "macos_kqueue_contract_rework_request.json",
    macosGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),

  jsonContract(
    "ipc_main_path_review_gate_decision",
    "ipc_main_path_review_gate_decision.json",
    ipcMainPathGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "ipc_main_path_review_approved_flag",
    "ipc_main_path_review_approved.flag",
    ipcMainPathGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "ipc_main_path_review_rework_request",
    "ipc_main_path_review_rework_request.json",
    ipcMainPathGateMatcher,
    { required: false, requiredWhen: "decision=rework_required" }
  ),

  jsonContract("unified_qa_verdict", "unified_qa_verdict.json", /统一发布前 QA verdict 汇总裁决/i),
  jsonContract(
    "qa_verdict_rework_request",
    "qa_verdict_rework_request.json",
    /统一 QA verdict 失败回流重规划/i
  ),
  jsonContract("release_binary_archive", "release_binary_archive.json", /发布二进制候选产物归档/i),
  jsonContract(
    "release_docs_evidence_archive",
    "release_docs_evidence_archive.json",
    /发布文档与证据索引归档/i
  ),
  jsonContract("rollback_plan", "rollback_plan.json", /回滚预案与回滚验证入口/i),
  jsonContract(
    "release_review_gate_decision",
    "release_review_gate_decision.json",
    releaseGateMatcher,
    { dependencyCondition: "manual_gate", sessionField: "aoSessionId" }
  ),
  flagContract(
    "release_approved_flag",
    "release_approved.flag",
    releaseGateMatcher,
    "decision=approved"
  ),
  jsonContract(
    "release_rework_request",
    "release_rework_request.json",
    /发布驳回回流重规划|最终发布人工复核门禁|release.*(?:manual_gate|review_gate)/i,
    { required: false, requiredWhen: "decision=rework_required" }
  )
];

const registry = new ArtifactContractRegistry(contracts);

function taskText(task: ExecutionTask): string {
  return [
    task.taskId,
    task.title,
    task.description,
    task.type,
    task.dependencyCondition,
    task.aoPrompt,
    ...task.acceptanceCriteria
  ].join("\n");
}

function regexMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function toTemplateArtifact(contract: ArtifactContract): {
  kind: string;
  file: string;
  required?: boolean;
  requiredWhen?: string;
} {
  return {
    kind: contract.kind,
    file: contract.canonicalFile,
    required: contract.required,
    ...(contract.requiredWhen ? { requiredWhen: contract.requiredWhen } : {})
  };
}

function requiredContract(registry: ArtifactContractRegistry, id: string): ArtifactContract {
  const contract = registry.findById(id);
  if (!contract) {
    throw new Error(`Artifact contract is not registered: ${id}`);
  }
  return contract;
}

function normalizeFileKey(file: string): string {
  return normalize(file).replace(/\\/g, "/").toLowerCase();
}

function addUniqueIssue(
  issues: ArtifactRegistryIssue[],
  seen: Set<string>,
  value: string,
  message: string
): void {
  if (seen.has(value)) {
    issues.push({ id: `unique-${value}`, severity: "blocking", message });
  }
  seen.add(value);
}

function isAllowedProjectRootCandidate(file: string): boolean {
  const normalized = normalize(file).replace(/\\/g, "/");
  return ["docs/", "config/", "schemas/", ".ao-control-plane/"].some((prefix) =>
    normalized.startsWith(prefix)
  );
}

function isContractActiveForPlanVersion(
  contract: ArtifactContract,
  activePlanVersion: "task-plan-current" | `task-plan-v${number}`
): boolean {
  return !contract.producer.expectedPlanVersion || contract.producer.expectedPlanVersion === activePlanVersion;
}

function evaluateRequiredWhenSyntax(expression: string): boolean {
  const parts = expression.split("&&").map((part) => part.trim());
  return parts.length > 0 && parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.-]+$/.test(part));
}
