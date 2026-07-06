import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";
import {
  ArtifactContractRegistry,
  getArtifactContractRegistry,
  getCandidatePaths,
  getRequiredJsonFields,
  serializeTaskMatcher,
  type ArtifactContract
} from "./artifact-contract-registry.js";

describe("artifact contract registry", () => {
  it("self-validates contract identity, candidate paths, and derived compatibility templates", () => {
    const registry = getArtifactContractRegistry();
    expect(registry.validate().filter((issue) => issue.severity === "blocking")).toEqual([]);
    expect(registry.deriveManualGateTemplates().map((template) => template.gateId)).toEqual(
      expect.arrayContaining([
        "ipc_contract",
        "transport_contract",
        "linux_backend",
        "windows_iocp",
        "macos_kqueue"
      ])
    );
    expect(
      registry
        .deriveTaskOutputTemplates()
        .flatMap((template) => template.artifacts.map((artifact) => artifact.kind))
    ).toEqual(
      expect.arrayContaining([
        "ipc_capacity_boundary_freeze",
        "transport_contract_freeze",
        "outbound_contract_freeze"
      ])
    );
  });

  it("matches high-risk workflow tasks to canonical control-plane artifacts", () => {
    const registry = getArtifactContractRegistry();
    const plan: TaskPlan = {
      workflowId: "WF-REGISTRY",
      title: "Plan",
      tasks: [
        task("TASK-007", "冻结 IPC 容量边界", "冻结 IPC 容量边界与共享段容量。"),
        task("TASK-008", "冻结共享传输抽象与平台边界", "输出共享传输抽象与平台边界冻结产物。"),
        task(
          "TASK-013",
          "冻结 OutboundTransport 发送契约",
          "输出 OutboundTransport 发送契约冻结产物。"
        ),
        task("TASK-062", "Linux 私有后端契约人工复核门禁", "复核 Linux 私有契约。", {
          dependencyCondition: "manual_gate"
        }),
        task("TASK-070", "Windows IOCP 私有后端契约人工复核门禁", "复核 Windows IOCP 私有契约。", {
          dependencyCondition: "manual_gate"
        }),
        task("TASK-076", "macOS kqueue 私有后端契约人工复核门禁", "复核 macOS kqueue 私有契约。", {
          dependencyCondition: "manual_gate"
        })
      ]
    };

    const byTask = new Map(
      plan.tasks.map((item) => [
        item.taskId,
        registry.findContractsForTask(item).map((contract) => contract.id)
      ])
    );

    expect(byTask.get("TASK-007")).toContain("ipc_capacity_boundary_freeze");
    expect(byTask.get("TASK-008")).toContain("transport_contract_freeze");
    expect(byTask.get("TASK-013")).toContain("outbound_contract_freeze");
    expect(byTask.get("TASK-062")).toContain("linux_backend_contract_review_gate_decision");
    expect(byTask.get("TASK-070")).toContain("windows_iocp_contract_review_gate_decision");
    expect(byTask.get("TASK-076")).toContain("macos_kqueue_contract_review_gate_decision");
  });

  it("exports manifest helper fields from a single registry source", () => {
    const registry = getArtifactContractRegistry();
    const contract = registry.findById("ipc_contract_review_gate_decision");

    expect(contract).toBeDefined();
    expect(serializeTaskMatcher(contract?.producer.taskMatcher ?? /missing/)).toContain("/i");
    expect(getRequiredJsonFields(contract as ArtifactContract)).toEqual(
      expect.arrayContaining(["workflowId", "taskId"])
    );
    expect(
      getCandidatePaths(contract as ArtifactContract, {
        artifactDir: "C:\\workspace\\fast-transport\\.ao-control-plane\\WF-REGISTRY",
        worktreePath: "C:\\workspace\\.agent-orchestrator\\worktrees\\ft-7",
        workflowId: "WF-REGISTRY"
      }).map((candidate) => candidate.absolutePath)
    ).toEqual(expect.arrayContaining([expect.stringContaining("ipc_contract_review_gate_decision.json")]));
  });

  it("uses expectedPlanVersion when matching task contracts", () => {
    const base = cloneContract(getArtifactContractRegistry().findById("g0_repo_reality_check"));
    base.producer.expectedPlanVersion = "task-plan-v2";
    const registry = new ArtifactContractRegistry([base]);
    const currentMatches = registry.findContractsForTask(
      task("TASK-001", "G0 仓库现实校准", "仓库现实校准。"),
      "task-plan-current"
    );
    const v2Matches = registry.findContractsForTask(
      task("TASK-001", "G0 仓库现实校准", "仓库现实校准。"),
      "task-plan-v2"
    );

    expect(currentMatches).toEqual([]);
    expect(v2Matches.map((contract) => contract.id)).toEqual(["g0_repo_reality_check"]);
  });

  it("validates duplicate required canonical claims and unsupported requiredWhen syntax", () => {
    const registry = getArtifactContractRegistry();
    const plan: TaskPlan = {
      workflowId: "WF-REGISTRY",
      title: "Plan",
      tasks: [
        task("TASK-001", "A", "A", {
          outputArtifacts: [
            { contractId: "g0_repo_reality_check", kind: "g0_repo_reality_check", path: "g0_repo_reality_check.json", required: true }
          ]
        }),
        task("TASK-002", "B", "B", {
          outputArtifacts: [
            { contractId: "g0_repo_reality_check", kind: "g0_repo_reality_check", path: "g0_repo_reality_check.json", required: true }
          ]
        })
      ]
    };

    expect(registry.validate(plan).map((issue) => issue.id)).toContain(
      "required-output-duplicate-g0_repo_reality_check.json"
    );

    const badRequiredWhen = cloneContract(registry.findById("g0_approved_flag"));
    badRequiredWhen.requiredWhen = "decision in approved";
    expect(new ArtifactContractRegistry([badRequiredWhen]).validate().map((issue) => issue.id)).toContain(
      "required-when-g0_approved_flag"
    );
  });

  it("rejects projectRoot .ao-control-plane candidates mixed with artifactDir candidates", () => {
    const registry = new ArtifactContractRegistry([
      baseContract({
        candidatePaths: [
          candidate(),
          candidate({
            relativeTo: "projectRoot",
            source: "legacy_alias",
            file: ".ao-control-plane/WF/base_contract.json",
            purpose: "legacy_alias",
            priority: 60
          })
        ]
      })
    ]);

    expect(registry.validate().map((issue) => issue.id)).toContain(
      "relativeTo-mutually-exclusive-base_contract"
    );
  });

  it("rejects exact candidate route collisions across contracts", () => {
    const route = candidate({
      relativeTo: "worktree",
      source: "worktree_control_plane",
      file: ".ao-control-plane/{workflowId}/shared.json",
      purpose: "primary",
      priority: 90
    });
    const registry = new ArtifactContractRegistry([
      baseContract({ candidatePaths: [candidate(), route] }),
      baseContract({
        id: "base_contract_copy",
        kind: "base_contract_copy",
        canonicalFile: "base_contract_copy.json",
        candidatePaths: [candidate({ file: "base_contract_copy.json" }), route]
      })
    ]);

    expect(
      registry.validate().some((issue) => issue.id.startsWith("candidate-route-conflict-"))
    ).toBe(true);
  });

  it.each([
    {
      name: "duplicate id",
      contracts: () => duplicateWith("id", "base_contract"),
      expected: "unique-base_contract"
    },
    {
      name: "duplicate kind",
      contracts: () => duplicateWith("kind", "base_contract"),
      expected: "unique-base_contract"
    },
    {
      name: "duplicate canonical file",
      contracts: () => duplicateWith("canonicalFile", "base_contract.json"),
      expected: "unique-base_contract.json"
    },
    {
      name: "uppercase canonical file",
      contracts: () => [baseContract({ canonicalFile: "Base_Contract.json" })],
      expected: "canonical-case-base_contract"
    },
    {
      name: "missing canonical candidate",
      contracts: () => [
        {
          ...baseContract(),
          candidatePaths: [candidate({ source: "worktree_control_plane", relativeTo: "worktree" })]
        }
      ],
      expected: "canonical-candidate-base_contract"
    },
    {
      name: "global task matcher",
      contracts: () => [baseContract({ producer: { ...baseProducer(), taskMatcher: /base/g } })],
      expected: "task-matcher-global-base_contract"
    },
    {
      name: "unsupported task type",
      contracts: () => [
        baseContract({
          producer: { ...baseProducer(), taskType: ["unsupported" as ExecutionTask["type"]] }
        })
      ],
      expected: "task-type-base_contract-unsupported"
    },
    {
      name: "bad requiredWhen",
      contracts: () => [baseContract({ requiredWhen: "decision in approved" })],
      expected: "required-when-base_contract"
    },
    {
      name: "duplicate candidate",
      contracts: () => [
        baseContract({ candidatePaths: [candidate(), candidate()] })
      ],
      expected: "candidate-duplicate-filename-base_contract-artifactDir:canonical:base_contract.json"
    },
    {
      name: "source purpose mismatch",
      contracts: () => [
        baseContract({ candidatePaths: [candidate({ purpose: "mirror" })] })
      ],
      expected: "candidate-purpose-base_contract"
    },
    {
      name: "project root outside whitelist",
      contracts: () => [
        baseContract({
          candidatePaths: [
            candidate(),
            candidate({ relativeTo: "projectRoot", source: "worktree_mirror", file: "src/base_contract.json", purpose: "mirror" })
          ]
        })
      ],
      expected: "project-root-candidate-base_contract"
    },
    {
      name: "case-sensitive filename collision",
      contracts: () => [
        baseContract({
          pathCaseSensitivity: "case_sensitive",
          candidatePaths: [
            candidate(),
            candidate({ file: "BASE_CONTRACT.json", source: "legacy_alias", purpose: "legacy_alias" })
          ]
        })
      ],
      expected: "case-sensitive-candidate-base_contract-base_contract.json"
    },
    {
      name: "required json missing workflow ownership",
      contracts: () => [baseContract({ ownership: { requiredFields: ["taskId"] } })],
      expected: "json-ownership-base_contract-workflowId"
    },
    {
      name: "required json missing task ownership",
      contracts: () => [baseContract({ ownership: { requiredFields: ["workflowId"] } })],
      expected: "json-ownership-base_contract-taskId"
    },
    {
      name: "flag missing ownership",
      contracts: () => [
        baseContract({
          contentType: "flag",
          canonicalFile: "base_contract.flag",
          ownership: { requiredFields: [] },
          flagOwnership: undefined
        })
      ],
      expected: "flag-ownership-base_contract"
    }
  ])("validates registry invariant: $name", ({ contracts, expected }) => {
    expect(new ArtifactContractRegistry(contracts()).validate().map((issue) => issue.id)).toContain(
      expected
    );
  });
});

function cloneContract(contract: ArtifactContract | undefined): ArtifactContract {
  if (!contract) {
    throw new Error("contract fixture missing");
  }
  return {
    ...contract,
    producer: {
      ...contract.producer,
      taskMatcher: new RegExp(contract.producer.taskMatcher.source, contract.producer.taskMatcher.flags)
    },
    candidatePaths: contract.candidatePaths.map((candidate) => ({ ...candidate })),
    ownership: { ...contract.ownership, requiredFields: [...contract.ownership.requiredFields] },
    jsonSchema: contract.jsonSchema
      ? { ...contract.jsonSchema, requiredFields: [...(contract.jsonSchema.requiredFields ?? [])] }
      : undefined
  };
}

function baseProducer(): ArtifactContract["producer"] {
  return {
    taskMatcher: /base/i,
    taskType: ["verification"]
  };
}

function candidate(
  overrides: Partial<ArtifactContract["candidatePaths"][number]> = {}
): ArtifactContract["candidatePaths"][number] {
  return {
    source: "canonical",
    relativeTo: "artifactDir",
    file: "base_contract.json",
    priority: 100,
    purpose: "primary",
    ...overrides
  };
}

function baseContract(overrides: Partial<ArtifactContract> = {}): ArtifactContract {
  return {
    id: "base_contract",
    kind: "base_contract",
    canonicalFile: "base_contract.json",
    required: true,
    contentType: "json",
    producer: baseProducer(),
    candidatePaths: [candidate()],
    jsonSchema: { requiredFields: ["workflowId", "taskId"] },
    ownership: { requiredFields: ["workflowId", "taskId"] },
    ...overrides
  };
}

function duplicateWith(
  field: "id" | "kind" | "canonicalFile",
  value: string
): ArtifactContract[] {
  return [
    baseContract({ [field]: value }),
    baseContract({
      id: field === "id" ? value : "base_contract_copy",
      kind: field === "kind" ? value : "base_contract_copy",
      canonicalFile: field === "canonicalFile" ? value : "base_contract_copy.json"
    })
  ];
}

function task(
  taskId: string,
  title: string,
  description: string,
  overrides: Partial<ExecutionTask> = {}
): ExecutionTask {
  return {
    taskId,
    workflowId: "WF-REGISTRY",
    title,
    description,
    type: "verification",
    dependencies: [],
    dependencyCondition: "all_completed",
    aoRole: "reviewer",
    acceptanceCriteria: ["产出控制面产物。"],
    aoPrompt: `[WF-REGISTRY / ${taskId}]\n任务名称：${title}\nAO 角色：reviewer\n验收标准：\n1. 产出控制面产物。\n上下文摘要：${description}`,
    status: "pending",
    executionPolicy: defaultExecutionPolicy,
    ...overrides
  };
}
