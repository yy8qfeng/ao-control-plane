#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const packageJsonPath = "package.json";
const appVersionPath = "src/app-version.ts";
const excludedReportPathspecs = [
  ":(exclude)docs/*review*.md",
  ":(exclude)docs/*remediation*.md",
  ":(exclude)docs/**/*review*.md",
  ":(exclude)docs/**/*remediation*.md"
];

const options = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const nextVersion = resolveNextVersion(packageJson.version, options.bump);
packageJson.version = nextVersion;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

syncAppVersion(nextVersion);

run("pnpm", ["typecheck"]);
run("pnpm", ["lint"]);
run("pnpm", ["test"]);

run("git", ["add", "--", ".", ...excludedReportPathspecs]);

const stagedFiles = readCommand("git", ["diff", "--cached", "--name-only"])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const blockedReports = stagedFiles.filter(isReportFile);
if (blockedReports.length > 0) {
  run("git", ["restore", "--staged", "--", ...blockedReports]);
  throw new Error(`Refusing to commit review/remediation reports:\n${blockedReports.join("\n")}`);
}
if (stagedFiles.length === 0) {
  throw new Error("No staged files to commit after excluding review/remediation reports.");
}

run("git", ["commit", "-m", options.message ?? `chore: release v${nextVersion}`]);

function parseArgs(args) {
  const parsed = { bump: "patch", message: undefined };
  const positionalMessageParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--major" || arg === "--minor" || arg === "--patch") {
      parsed.bump = arg.slice(2);
      continue;
    }
    if (arg === "-m" || arg === "--message") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a commit message.`);
      }
      parsed.message = value;
      index += 1;
      continue;
    }
    positionalMessageParts.push(arg);
  }
  if (!parsed.message && positionalMessageParts.length > 0) {
    parsed.message = positionalMessageParts.join(" ");
  }
  return parsed;
}

function bumpVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported semver version: ${version}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "major") {
    return `${major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function resolveNextVersion(currentVersion, bump) {
  const headVersion = readHeadPackageVersion();
  if (headVersion) {
    const expectedPendingVersion = bumpVersion(headVersion, bump);
    if (currentVersion === expectedPendingVersion) {
      return currentVersion;
    }
  }
  return bumpVersion(currentVersion, bump);
}

function readHeadPackageVersion() {
  try {
    const source = readCommand("git", ["show", "HEAD:package.json"]);
    const packageJsonAtHead = JSON.parse(source);
    return typeof packageJsonAtHead.version === "string" ? packageJsonAtHead.version : undefined;
  } catch {
    return undefined;
  }
}

function syncAppVersion(version) {
  const source = readFileSync(appVersionPath, "utf8");
  const versionPattern = /export const appVersion = "([^"]+)";/;
  if (!versionPattern.test(source)) {
    throw new Error(`Unable to update ${appVersionPath}.`);
  }
  const updated = source.replace(
    versionPattern,
    `export const appVersion = "${version}";`
  );
  writeFileSync(appVersionPath, updated);
}

function isReportFile(file) {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.startsWith("docs/") &&
    normalized.endsWith(".md") &&
    (normalized.includes("review") || normalized.includes("remediation"))
  );
}

function readCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: shouldUseShell(command) });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `${command} ${args.join(" ")} failed.`);
  }
  return result.stdout;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: shouldUseShell(command) });
  if (result.status !== 0) {
    throw new Error(
      result.error?.message || `${command} ${args.join(" ")} failed with exit code ${result.status}.`
    );
  }
}

function shouldUseShell(command) {
  return process.platform === "win32" && command === "pnpm";
}
