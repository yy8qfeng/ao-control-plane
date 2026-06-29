import { readdir } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  currentPath?: string;
  parentPath?: string;
  roots: DirectoryEntry[];
  directories: DirectoryEntry[];
}

export async function browseDirectories(path: string | undefined): Promise<DirectoryListing> {
  const roots = await getRoots();
  if (!path?.trim()) {
    return {
      roots,
      directories: []
    };
  }

  const currentPath = resolve(path);
  const entries = await readdir(currentPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: resolve(currentPath, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    currentPath,
    parentPath: getParentPath(currentPath),
    roots,
    directories
  };
}

async function getRoots(): Promise<DirectoryEntry[]> {
  if (process.platform !== "win32") {
    return [{ name: "/", path: "/" }];
  }

  const roots = new Set<string>([parse(process.cwd()).root]);
  const systemDrive = process.env.SystemDrive;
  if (systemDrive) {
    roots.add(`${systemDrive}\\`);
  }

  return Array.from(roots).map((path) => ({ name: path, path }));
}

function getParentPath(path: string): string | undefined {
  const root = parse(path).root;
  if (path === root) {
    return undefined;
  }

  return dirname(path);
}
