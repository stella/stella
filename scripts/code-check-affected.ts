#!/usr/bin/env bun

// Fast local code-quality gate.
//
// CI keeps the full repository-wide `code-check`. Pre-push uses this wrapper
// to ask Turbo for changed workspaces plus reverse dependants, then caches each
// workspace's complete lint and typecheck independently with bounded
// concurrency. Root scripts sit outside Turbo, so only changed root sources are
// linted directly. Global inputs conservatively fall back to the full check.

import { panic } from "better-result";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { isChangedLintPath } from "./lint-paths";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";
const WORKSPACE_PARENTS = ["apps", "packages"] as const;

const FULL_CHECK_FILES = new Set([
  ".npmrc",
  "bun.lock",
  "bunfig.toml",
  "oxlint.config.ts",
  "package.json",
  "scripts/code-check-affected.ts",
  "scripts/lint-paths.ts",
  "scripts/lint-oxlint-fixtures.sh",
  "scripts/lint-root-scripts.sh",
  "scripts/tsconfig.json",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.oxlint-plugins.json",
  "tsconfig.scripts.json",
  "tsconfig.tooling.json",
]);

const FULL_CHECK_PREFIXES = [
  ".oxlint-plugins/",
  "packages/typescript-config/",
  "patches/",
  "types/",
] as const;

type CheckPlan =
  | { type: "full"; changedPath: string }
  | {
      type: "affected";
      targets: string[];
      rootLintPaths: string[];
    };

type PlanCheckOptions = {
  changedPaths: readonly string[];
  presentChangedPaths: readonly string[];
  affectedWorkspacePaths: readonly string[];
  workspacePaths: ReadonlySet<string>;
};

const workspaceForPath = (file: string): string | null => {
  const segments = file.split("/");
  const parent = segments.at(0);
  const name = segments.at(1);
  if (
    parent === undefined ||
    name === undefined ||
    !WORKSPACE_PARENTS.some((workspaceParent) => workspaceParent === parent)
  ) {
    return null;
  }
  return `${parent}/${name}`;
};

const requiresFullCheck = (file: string): boolean =>
  FULL_CHECK_FILES.has(file) ||
  FULL_CHECK_PREFIXES.some((prefix) => file.startsWith(prefix));

export const planCheck = ({
  changedPaths,
  presentChangedPaths,
  affectedWorkspacePaths,
  workspacePaths,
}: PlanCheckOptions): CheckPlan => {
  for (const changedPath of changedPaths) {
    if (requiresFullCheck(changedPath)) {
      return { type: "full", changedPath };
    }
  }

  const targets = [...new Set(affectedWorkspacePaths)].sort();
  if (targets.some((target) => !workspacePaths.has(target))) {
    return { type: "full", changedPath: "invalid Turbo workspace output" };
  }

  const targetSet = new Set(targets);
  for (const changedPath of changedPaths) {
    const owner = workspaceForPath(changedPath);
    if (owner === null) {
      continue;
    }
    if (!workspacePaths.has(owner) || !targetSet.has(owner)) {
      return { type: "full", changedPath };
    }
  }

  return {
    type: "affected",
    targets,
    rootLintPaths: [
      ...new Set(
        presentChangedPaths.filter(
          (changedPath) =>
            workspaceForPath(changedPath) === null &&
            isChangedLintPath(changedPath),
        ),
      ),
    ].sort(),
  };
};

type Options = {
  base: string;
  dryRun: boolean;
};

const parseArgs = (args: readonly string[]): Options => {
  let base = DEFAULT_BASE;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--base") {
      const value = args.at(index + 1);
      if (value === undefined) {
        panic("--base requires a git ref");
      }
      base = value;
      index += 1;
      continue;
    }
    panic(`Unknown argument: ${argument}`);
  }

  return { base, dryRun };
};

const run = (
  command: readonly string[],
  options: { capture?: boolean; env?: Record<string, string | undefined> } = {},
): string => {
  const capture = options.capture ?? false;
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.exitCode !== 0) {
    const output = capture ? `\n${stderr}${stdout}` : "";
    panic(`Command failed (${result.exitCode}): ${command.join(" ")}${output}`);
  }
  return stdout;
};

const workspacePaths = (): Set<string> => {
  const workspaces = new Set<string>();
  for (const parent of WORKSPACE_PARENTS) {
    for (const entry of readdirSync(path.join(REPO_ROOT, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspace = `${parent}/${entry.name}`;
      if (existsSync(path.join(REPO_ROOT, workspace, "package.json"))) {
        workspaces.add(workspace);
      }
    }
  }
  return workspaces;
};

const changedPaths = (base: string): { mergeBase: string; paths: string[] } => {
  const mergeBase = run(["git", "merge-base", base, "HEAD"], {
    capture: true,
  }).trim();
  if (mergeBase === "") {
    panic(`Could not find merge base for ${base}`);
  }
  const output = run(["git", "diff", "--name-only", "-z", mergeBase, "HEAD"], {
    capture: true,
  });
  return {
    mergeBase,
    paths: output.split("\0").filter(Boolean),
  };
};

type TurboOutput = {
  packages?: {
    items?: { path?: unknown }[];
  };
};

const affectedWorkspacePaths = (mergeBase: string): string[] => {
  const output = run(
    ["bun", "--bun", "turbo", "ls", "--affected", "--output=json"],
    {
      capture: true,
      env: {
        ...process.env,
        TURBO_SCM_BASE: mergeBase,
        TURBO_SCM_HEAD: "HEAD",
      },
    },
  );
  const jsonStart = output.indexOf("{");
  if (jsonStart === -1) {
    panic("Turbo affected output did not contain JSON");
  }
  const parsed: TurboOutput = JSON.parse(output.slice(jsonStart));
  const items = parsed.packages?.items;
  if (!Array.isArray(items)) {
    panic("Turbo affected output did not contain package items");
  }
  return items.map(({ path: workspacePath }) => {
    if (typeof workspacePath !== "string") {
      panic("Turbo affected output contained a package without a path");
    }
    return workspacePath;
  });
};

export const affectedCommands = (
  plan: Extract<CheckPlan, { type: "affected" }>,
) => {
  const commands: string[][] = [["bun", "run", "env:check"]];
  if (plan.rootLintPaths.length > 0) {
    commands.push([
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--report-unused-disable-directives-severity=error",
      "--deny-warnings",
      "--type-aware",
      ...plan.rootLintPaths,
    ]);
  }
  if (plan.targets.length > 0) {
    commands.push([
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "typecheck",
      "--concurrency=2",
      ...plan.targets.map((target) => `--filter=./${target}`),
    ]);
  }
  commands.push(["bun", "run", "typecheck:repo"]);
  return commands;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const changed = changedPaths(options.base);
  const plan = planCheck({
    changedPaths: changed.paths,
    presentChangedPaths: changed.paths.filter((changedPath) =>
      existsSync(path.join(REPO_ROOT, changedPath)),
    ),
    affectedWorkspacePaths: affectedWorkspacePaths(changed.mergeBase),
    workspacePaths: workspacePaths(),
  });

  if (plan.type === "full") {
    process.stdout.write(
      `code-check: full repository (${plan.changedPath} requires fallback)\n`,
    );
    if (!options.dryRun) {
      run(["bun", "run", "code-check"]);
    }
    return;
  }

  const targetLabel =
    plan.targets.length === 0 ? "root projects only" : plan.targets.join(", ");
  process.stdout.write(`code-check: affected ${targetLabel}\n`);
  const commands = affectedCommands(plan);
  if (options.dryRun) {
    for (const command of commands) {
      process.stdout.write(`  ${command.join(" ")}\n`);
    }
    return;
  }
  for (const command of commands) {
    run(command);
  }
};

if (import.meta.main) {
  main();
}
