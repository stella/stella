#!/usr/bin/env bun

import { panic, TaggedError } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

type TypecheckBudgetExclusion = {
  measuredMemory: string;
  measuredTime: string;
  name: string;
};

export const TYPECHECK_BUDGET_EXCLUSIONS = [
  {
    name: "@stll/web",
    measuredTime: "75.6 s",
    measuredMemory: "1.14 GB",
  },
] as const satisfies readonly TypecheckBudgetExclusion[];

export const validateTypecheckBudgetExclusions = (
  exclusions: readonly TypecheckBudgetExclusion[],
  workspaceNames: ReadonlySet<string>,
): void => {
  for (const exclusion of exclusions) {
    if (!workspaceNames.has(exclusion.name)) {
      panic(
        `pre-push-typecheck: budget exclusion names unknown package ${exclusion.name}`,
      );
    }
  }
};

export const runSelectedPackages = async (
  packages: readonly PackageSelection[],
  runTypecheck: (workspace: PackageSelection) => Promise<number>,
  report: (message: string) => void,
): Promise<number> => {
  for (const workspace of packages) {
    const budgetExclusion = TYPECHECK_BUDGET_EXCLUSIONS.find(
      ({ name }) => name === workspace.name,
    );
    if (budgetExclusion !== undefined) {
      report(
        `pre-push-typecheck: ${workspace.name} skipped (${budgetExclusion.measuredTime}, ${budgetExclusion.measuredMemory} measured; over the pre-push budget); CI checks it`,
      );
      continue;
    }
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

class PackageSelectionError extends TaggedError("PackageSelectionError")<{
  message: string;
}> {}

export const selectTouchedPackages = (
  changedFiles: readonly string[],
  manifestExists: (directory: string) => boolean,
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

  return [...directories]
    .toSorted()
    .filter(manifestExists)
    .map((directory) => {
      const manifest = readManifest(directory);
      const name =
        typeof manifest.name === "string" ? manifest.name : directory;
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
    stderr: "pipe",
  });
  if (mergeBase.exitCode !== 0) {
    throw new PackageSelectionError({
      message:
        mergeBase.stderr.toString().trim() ||
        `git merge-base exited ${childExitStatus(mergeBase)}`,
    });
  }
  const diff = Bun.spawnSync(
    [
      "git",
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACMRD",
      mergeBase.stdout.toString().trim(),
      "HEAD",
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (diff.exitCode !== 0) {
    throw new PackageSelectionError({
      message:
        diff.stderr.toString().trim() ||
        `git diff exited ${childExitStatus(diff)}`,
    });
  }
  return diff.stdout.toString().split("\0").filter(Boolean);
};

const main = async () => {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex === -1 ? DEFAULT_BASE : process.argv[baseIndex + 1];
  if (base === undefined || base.startsWith("--")) {
    panic("--base requires a git ref");
  }
  const repoRootIndex = process.argv.indexOf("--repo-root");
  const repoRoot =
    repoRootIndex === -1 ? REPO_ROOT : process.argv[repoRootIndex + 1];
  if (repoRoot === undefined || repoRoot.startsWith("--")) {
    panic("--repo-root requires a path");
  }
  let packages: PackageSelection[];
  try {
    const workspaceNames = new Set(
      ["apps", "packages"].flatMap((workspaceDirectory) =>
        readdirSync(path.join(repoRoot, workspaceDirectory), {
          withFileTypes: true,
        })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) => {
            const manifestPath = path.join(
              repoRoot,
              workspaceDirectory,
              entry.name,
              "package.json",
            );
            if (!existsSync(manifestPath)) {
              return [];
            }
            const manifest: PackageManifest = JSON.parse(
              readFileSync(manifestPath, "utf-8"),
            );
            return typeof manifest.name === "string" ? [manifest.name] : [];
          }),
      ),
    );
    validateTypecheckBudgetExclusions(
      TYPECHECK_BUDGET_EXCLUSIONS,
      workspaceNames,
    );
    packages = selectTouchedPackages(
      changedFilesAgainst(base, repoRoot),
      (directory) => existsSync(path.join(repoRoot, directory, "package.json")),
      (directory) =>
        JSON.parse(
          readFileSync(path.join(repoRoot, directory, "package.json"), "utf-8"),
        ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `pre-push-typecheck: package selection failed (${message}); CI checks the packages`,
    );
    return 0;
  }

  return runSelectedPackages(
    packages,
    async (workspace) => {
      const child = Bun.spawn(["bun", "run", "typecheck"], {
        cwd: path.join(repoRoot, workspace.directory),
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
