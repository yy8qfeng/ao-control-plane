import { getArtifactContractRegistry } from "./artifact-contract-registry.js";

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

/**
 * @deprecated The artifact contract registry is the source of truth. This file is a compatibility shell.
 */
export const manualGateTemplates: ManualGateTemplate[] =
  getArtifactContractRegistry().deriveManualGateTemplates();

/**
 * @deprecated The artifact contract registry is the source of truth. This file is a compatibility shell.
 */
export const taskOutputTemplates: TaskOutputTemplate[] =
  getArtifactContractRegistry().deriveTaskOutputTemplates();
