#!/usr/bin/env bun

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/u;
const WORKSPACE_SOURCE = /^(apps|packages)\/([^/]+)\//u;

type PackageSelection = {
  directory: string;
  name: string;
  typecheck: string | undefined;
};

export const runSelectedPackages = async (
  packages: readonly PackageSelection[],
  runTypecheck: (workspace: PackageSelection) => Promise<number>,
  report: (message: string) => void,
): Promise<number> => {
  for (const workspace of packages) {
    if (workspace.typecheck === undefined) {
      report(
        `pre-push typecheck: skipping ${workspace.name} (no typecheck script)`,
      );
      continue;
    }
    report(`pre-push typecheck: checking ${workspace.name}`);
    const status = await runTypecheck(workspace);
    if (status !== 0) {
      return status;
    }
  }
  return 0;
};

type PackageManifest = {
  name?: unknown;
  scripts?: { typecheck?: unknown };
};

export const selectTouchedPackages = (
  changedFiles: readonly string[],
  readManifest: (directory: string) => PackageManifest,
): PackageSelection[] => {
  const directories = new Set<string>();
  for (const file of changedFiles) {
    if (!TYPESCRIPT_SOURCE.test(file)) {
      continue;
    }
    const match = WORKSPACE_SOURCE.exec(file);
    if (match === null) {
      continue;
    }
    const [, workspaceKind, workspaceName] = match;
    if (workspaceKind === undefined || workspaceName === undefined) {
      panic("workspace package path matched without its required segments");
    }
    directories.add(`${workspaceKind}/${workspaceName}`);
  }

  return [...directories].toSorted().map((directory) => {
    const manifest = readManifest(directory);
    const name = typeof manifest.name === "string" ? manifest.name : directory;
    const typecheck = manifest.scripts?.typecheck;
    return {
      directory,
      name,
      typecheck: typeof typecheck === "string" ? typecheck : undefined,
    };
  });
};

export const changedFilesAgainst = (
  base: string,
  cwd = REPO_ROOT,
): string[] => {
  const mergeBase = Bun.spawnSync(["git", "merge-base", base, "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (mergeBase.exitCode !== 0) {
    process.exit(childExitStatus(mergeBase));
  }
  const diff = Bun.spawnSync(
    [
      "git",
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=ACMRD",
      mergeBase.stdout.toString().trim(),
      "HEAD",
    ],
    { cwd, stdout: "pipe", stderr: "inherit" },
  );
  if (diff.exitCode !== 0) {
    process.exit(childExitStatus(diff));
  }
  return diff.stdout.toString().split("\0").filter(Boolean);
};

const main = async () => {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex === -1 ? DEFAULT_BASE : process.argv[baseIndex + 1];
  if (base === undefined || base.startsWith("--")) {
    panic("--base requires a git ref");
  }
  const packages = selectTouchedPackages(
    changedFilesAgainst(base),
    (directory) =>
      JSON.parse(
        readFileSync(path.join(REPO_ROOT, directory, "package.json"), "utf-8"),
      ),
  );

  return runSelectedPackages(
    packages,
    async (workspace) => {
      const child = Bun.spawn(["bun", "run", "typecheck"], {
        cwd: path.join(REPO_ROOT, workspace.directory),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return childExitStatus(await child.exited);
    },
    console.log,
  );
};

if (import.meta.main) {
  process.exit(await main());
}
