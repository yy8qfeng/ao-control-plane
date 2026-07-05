import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProjectConfig {
  recentProjectRoots: string[];
  selectedProjectRoot?: string;
  requirementDraft?: RequirementDraft;
  requirementDrafts?: RequirementDraft[];
}

export interface RequirementDraft {
  workflowId?: string;
  title: string;
  projectRoot?: string;
  description: string;
  discussion?: string;
  acceptanceCriteria?: string;
  constraints?: string;
  maxDesignReviewRounds: number;
  updatedAt: string;
  draftKey?: string;
}

export class ProjectConfigStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<ProjectConfig> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as ProjectConfig;
      return {
        recentProjectRoots: parsed.recentProjectRoots ?? [],
        selectedProjectRoot: parsed.selectedProjectRoot,
        requirementDraft: parsed.requirementDraft,
        requirementDrafts: normalizeDrafts(parsed)
      };
    } catch {
      return { recentProjectRoots: [] };
    }
  }

  async rememberProjectRoot(projectRoot: string): Promise<ProjectConfig> {
    return this.enqueueWrite(async () => {
      const normalized = projectRoot.trim();
      const current = await this.read();
      if (!normalized) {
        return current;
      }

      const recentProjectRoots = [
        normalized,
        ...current.recentProjectRoots.filter((item) => item !== normalized)
      ].slice(0, 8);
      const next = {
        recentProjectRoots,
        selectedProjectRoot: normalized,
        requirementDraft: current.requirementDraft,
        requirementDrafts: current.requirementDrafts
      };

      await this.writeConfig(next);
      return next;
    });
  }

  async saveRequirementDraft(draft: Omit<RequirementDraft, "updatedAt">): Promise<ProjectConfig> {
    return this.enqueueWrite(async () => {
      const current = await this.read();
      const existingWorkflowDraftForTitle = draft.workflowId
        ? undefined
        : (current.requirementDrafts ?? []).find((item) =>
            Boolean(item.workflowId) && getTitleDraftKey(item) === getTitleDraftKey(draft)
          );
      if (existingWorkflowDraftForTitle) {
        const next = {
          ...current,
          requirementDraft: existingWorkflowDraftForTitle,
          requirementDrafts: current.requirementDrafts
        };
        await this.writeConfig(next);
        return next;
      }

      const requirementDraft = {
        ...draft,
        draftKey: getDraftKey(draft),
        updatedAt: new Date().toISOString()
      };
      const duplicateKeys = new Set([requirementDraft.draftKey, getTitleDraftKey(draft)]);
      const requirementDrafts = [
        requirementDraft,
        ...(current.requirementDrafts ?? []).filter((item) => !hasDuplicateDraftKey(item, duplicateKeys))
      ].slice(0, 20);
      const next = {
        ...current,
        selectedProjectRoot: draft.projectRoot?.trim() || current.selectedProjectRoot,
        requirementDraft,
        requirementDrafts
      };

      await this.writeConfig(next);
      return next;
    });
  }

  async clearRequirementDraft(): Promise<ProjectConfig> {
    return this.enqueueWrite(async () => {
      const current = await this.read();
      const next = {
        recentProjectRoots: current.recentProjectRoots,
        selectedProjectRoot: current.selectedProjectRoot,
        requirementDrafts: current.requirementDrafts
      };

      await this.writeConfig(next);
      return next;
    });
  }

  async deleteRequirementDraft(draftKey: string): Promise<{
    config: ProjectConfig;
    deletedDraft?: RequirementDraft;
  }> {
    return this.enqueueWrite(async () => {
      const current = await this.read();
      const deletedDraft =
        (current.requirementDrafts ?? []).find((item) => getDraftKey(item) === draftKey) ??
        (current.requirementDraft && getDraftKey(current.requirementDraft) === draftKey
          ? current.requirementDraft
          : undefined);
      const requirementDrafts = (current.requirementDrafts ?? []).filter(
        (item) => getDraftKey(item) !== draftKey
      );
      const requirementDraft =
        current.requirementDraft && getDraftKey(current.requirementDraft) !== draftKey
          ? current.requirementDraft
          : requirementDrafts[0];
      const next = {
        recentProjectRoots: current.recentProjectRoots,
        selectedProjectRoot: current.selectedProjectRoot,
        requirementDraft,
        requirementDrafts
      };

      await this.writeConfig(next);
      return { config: next, deletedDraft };
    });
  }

  private async writeConfig(config: ProjectConfig): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function normalizeDrafts(config: ProjectConfig): RequirementDraft[] {
  const drafts = [
    ...(config.requirementDraft ? [config.requirementDraft] : []),
    ...(config.requirementDrafts ?? [])
  ];
  const seen = new Set<string>();
  const result: RequirementDraft[] = [];

  for (const draft of drafts) {
    const draftKey = getDraftKey(draft);
    if (seen.has(draftKey)) {
      continue;
    }
    seen.add(draftKey);
    result.push({ ...draft, draftKey });
  }

  return result
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 20);
}

function getDraftKey(draft: Pick<RequirementDraft, "workflowId" | "title" | "draftKey">): string {
  const workflowId = draft.workflowId?.trim();
  if (workflowId) {
    return `workflow:${workflowId}`;
  }

  return getTitleDraftKey(draft);
}

function getTitleDraftKey(draft: Pick<RequirementDraft, "title">): string {
  const title = draft.title.trim().toLowerCase();
  return `draft:${title}`;
}

function getLegacyContentDraftKey(draft: Pick<RequirementDraft, "title" | "description">): string {
  const title = draft.title.trim().toLowerCase();
  const description = draft.description.trim().toLowerCase();
  return `draft:${title}:${description}`;
}

function hasDuplicateDraftKey(
  draft: Pick<RequirementDraft, "workflowId" | "title" | "description" | "draftKey">,
  duplicateKeys: Set<string>
): boolean {
  return duplicateKeys.has(getDraftKey(draft)) || duplicateKeys.has(getLegacyContentDraftKey(draft));
}
