import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProjectConfig {
  recentProjectRoots: string[];
  selectedProjectRoot?: string;
}

export class ProjectConfigStore {
  constructor(private readonly file: string) {}

  async read(): Promise<ProjectConfig> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as ProjectConfig;
      return {
        recentProjectRoots: parsed.recentProjectRoots ?? [],
        selectedProjectRoot: parsed.selectedProjectRoot
      };
    } catch {
      return { recentProjectRoots: [] };
    }
  }

  async rememberProjectRoot(projectRoot: string): Promise<ProjectConfig> {
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
      selectedProjectRoot: normalized
    };

    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}
