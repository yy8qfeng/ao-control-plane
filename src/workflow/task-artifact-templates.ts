export interface ArtifactTemplate {
  kind: string;
  file: string;
  required?: boolean;
  requiredWhen?: string;
}

export interface ManualGateTemplate {
  gateId: string;
  match: RegExp;
  input?: ArtifactTemplate;
  decision: ArtifactTemplate;
  flag: ArtifactTemplate;
  rework?: ArtifactTemplate;
}

export interface TaskOutputTemplate {
  match: RegExp;
  artifacts: ArtifactTemplate[];
}

export const manualGateTemplates: ManualGateTemplate[] = [
  {
    gateId: "g0",
    match: /G0.*人工复核放行|人工复核放行/,
    input: { kind: "g0_repo_reality_check", file: "g0_repo_reality_check.json", required: true },
    decision: { kind: "g0_review_gate_decision", file: "g0_review_gate_decision.json", required: true },
    flag: { kind: "g0_approved_flag", file: "g0_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "g0_replan_request", file: "g0_replan_request.json", required: false }
  },
  {
    gateId: "ipc_contract",
    match: /IPC.*契约.*人工复核门禁|跨语言 IPC 契约人工复核门禁/i,
    decision: { kind: "ipc_contract_review_gate_decision", file: "ipc_contract_review_gate_decision.json", required: true },
    flag: { kind: "ipc_contract_approved_flag", file: "ipc_contract_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "ipc_contract_rework_request", file: "ipc_contract_rework_request.json", required: false }
  },
  {
    gateId: "transport_contract",
    match: /共享传输抽象契约人工复核门禁|transport_contract.*(?:manual_gate|review_gate)/i,
    decision: { kind: "transport_contract_review_gate_decision", file: "transport_contract_review_gate_decision.json", required: true },
    flag: { kind: "transport_contract_approved_flag", file: "transport_contract_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "transport_contract_rework_request", file: "transport_contract_rework_request.json", required: false }
  },
  {
    gateId: "outbound_contract",
    match: /OutboundTransport.*契约人工复核门禁|发送契约人工复核门禁|outbound_contract.*(?:manual_gate|review_gate)/i,
    decision: { kind: "outbound_contract_review_gate_decision", file: "outbound_contract_review_gate_decision.json", required: true },
    flag: { kind: "outbound_contract_approved_flag", file: "outbound_contract_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "outbound_contract_rework_request", file: "outbound_contract_rework_request.json", required: false }
  },
  {
    gateId: "platform_adapter",
    match: /平台适配器.*人工复核门禁|platform_adapter.*(?:manual_gate|review_gate)/i,
    decision: { kind: "platform_adapter_review_gate_decision", file: "platform_adapter_review_gate_decision.json", required: true },
    flag: { kind: "platform_adapter_approved_flag", file: "platform_adapter_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "platform_adapter_rework_request", file: "platform_adapter_rework_request.json", required: false }
  },
  {
    gateId: "jar_api_contract",
    match: /JAR.*契约人工复核门禁|JAR 公开 API.*人工复核门禁|jar_api_contract.*(?:manual_gate|review_gate)/i,
    decision: { kind: "jar_api_contract_review_gate_decision", file: "jar_api_contract_review_gate_decision.json", required: true },
    flag: { kind: "jar_api_contract_approved_flag", file: "jar_api_contract_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "jar_api_contract_rework_request", file: "jar_api_contract_rework_request.json", required: false }
  },
  {
    gateId: "shared_boundary",
    match: /共享文件边界.*人工门禁|shared_boundary.*(?:manual_gate|review_gate)/i,
    decision: { kind: "shared_boundary_review_gate_decision", file: "shared_boundary_review_gate_decision.json", required: true },
    flag: { kind: "shared_boundary_approved_flag", file: "shared_boundary_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "shared_boundary_rework_request", file: "shared_boundary_rework_request.json", required: false }
  },
  {
    gateId: "release",
    match: /最终发布人工复核门禁/i,
    decision: { kind: "release_review_gate_decision", file: "release_review_gate_decision.json", required: true },
    flag: { kind: "release_approved_flag", file: "release_approved.flag", required: false, requiredWhen: "decision=approved" },
    rework: { kind: "release_rework_request", file: "release_rework_request.json", required: false }
  }
];

export const taskOutputTemplates: TaskOutputTemplate[] = [
  {
    match: /仓库现实校准/,
    artifacts: [{ kind: "g0_repo_reality_check", file: "g0_repo_reality_check.json", required: true }]
  },
  {
    match: /治理门禁决策文件|gate 文件|回流规范/,
    artifacts: [
      { kind: "gate_governance_freeze", file: "gate_governance_freeze.json", required: true },
      { kind: "gate_governance_freeze_markdown", file: "gate_governance_freeze.md", required: true },
      { kind: "gate_decision_schema", file: "gate_decision_schema.json", required: true },
      { kind: "qa_verdict", file: "qa_verdict.json", required: true }
    ]
  },
  {
    match: /跨语言 IPC 核心字节布局契约/,
    artifacts: [
      { kind: "ipc_byte_layout_freeze", file: "ipc_byte_layout_freeze.json", required: true },
      { kind: "ipc_byte_layout_freeze_markdown", file: "ipc_byte_layout_freeze.md", required: true },
      { kind: "ipc_byte_layout_qa_verdict", file: "ipc_byte_layout_qa_verdict.json", required: true }
    ]
  },
  {
    match: /共享传输抽象与平台边界/,
    artifacts: [
      { kind: "transport_contract_freeze", file: "transport_contract_freeze.json", required: true },
      { kind: "transport_contract_freeze_markdown", file: "transport_contract_freeze.md", required: false }
    ]
  },
  {
    match: /OutboundTransport.*发送契约/,
    artifacts: [
      { kind: "outbound_contract_freeze", file: "outbound_contract_freeze.json", required: true },
      { kind: "outbound_contract_freeze_markdown", file: "outbound_contract_freeze.md", required: false }
    ]
  },
  {
    match: /平台适配器统一接口与状态映射契约/,
    artifacts: [{ kind: "platform_adapter_contract", file: "platform_adapter_contract.json", required: true }]
  },
  {
    match: /JDK 21 JAR 公开 API 与示例依赖契约/,
    artifacts: [{ kind: "jar_api_contract_freeze", file: "jar_api_contract_freeze.json", required: true }]
  },
  {
    match: /跨平台后端特性矩阵与共享夹具契约/,
    artifacts: [{ kind: "shared_boundary_manifest", file: "shared_boundary_manifest.json", required: true }]
  },
  {
    match: /统一发布前 QA verdict 汇总裁决/,
    artifacts: [{ kind: "unified_qa_verdict", file: "unified_qa_verdict.json", required: true }]
  },
  {
    match: /统一 QA verdict 失败回流重规划/,
    artifacts: [{ kind: "qa_verdict_rework_request", file: "qa_verdict_rework_request.json", required: true }]
  },
  {
    match: /发布驳回回流重规划/,
    artifacts: [{ kind: "release_rework_request", file: "release_rework_request.json", required: true }]
  },
  {
    match: /发布二进制候选产物归档/,
    artifacts: [{ kind: "release_binary_archive", file: "release_binary_archive.json", required: true }]
  },
  {
    match: /发布文档与证据索引归档/,
    artifacts: [{ kind: "release_docs_evidence_archive", file: "release_docs_evidence_archive.json", required: true }]
  },
  {
    match: /回滚预案与回滚验证入口/,
    artifacts: [{ kind: "rollback_plan", file: "rollback_plan.json", required: true }]
  }
];
