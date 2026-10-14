#!/usr/bin/env bun

// Affected cheap checks before a push.
//
// Lint, typecheck and root script tests fail most red pull request runs, and
// CI reports them only after the whole workflow has run. This runs the same
// checks for the pushed change, one task at a time, so they fail locally in
// the time the affected scope needs:
//
//   1. the route, API and capability generators, so checks read current outputs;
//   2. scripts/code-check-affected.ts, the exact lint and typecheck plan of
//      CI's Code quality legs, at concurrency 1. A change that needs the full
//      repository check is left to CI;
//   3. the tests of changed root scripts.
//
// The repository's own pre-push hook stays lightweight (see
// scripts/pre-push-policy.test.ts). A host-level hook runs this only when the
// machine has memory headroom, and CI still runs every check.
//
//   bun scripts/pre-push-affected.ts [--base origin/main] [--dry-run]

import { existsSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";
/** Matches CI's root script test timeout. */
const SCRIPT_TEST_TIMEOUT_MS = "35000";

class PrePushAffectedError extends Error {
  readonly _tag = "PrePushAffectedError";

  constructor(message: string) {
    super(message);
    this.name = "PrePushAffectedError";
  }
}

const panic = (message: string): never => {
  throw new PrePushAffectedError(message);
};

type Options = { base: string; dryRun: boolean };

export const parsePrePushArgs = (args: readonly string[]): Options => {
  let base = DEFAULT_BASE;
  let dryRun = false;
  const argv = args.values();
  for (const argument of argv) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--base") {
      const value = argv.next().value;
      base =
        value === undefined || value.startsWith("--")
          ? panic("--base requires a git ref")
          : value;
      continue;
    }
    panic(`Unknown argument: ${argument}`);
  }
  return { base, dryRun };
};

const ROOT_SCRIPT = /^scripts\/[^/]+\.ts$/u;

/** Tests of changed root scripts: a changed test, or the test beside a changed script. */
export const rootScriptTests = (
  changedPaths: readonly string[],
  exists: (file: string) => boolean,
): string[] =>
  [
    ...new Set(
      changedPaths
        .filter((file) => ROOT_SCRIPT.test(file))
        .map((file) =>
          file.endsWith(".test.ts") ? file : file.replace(/\.ts$/u, ".test.ts"),
        )
        .filter(exists),
    ),
  ].toSorted();

export const prePushCommands = ({
  base,
  scriptTests,
}: {
  base: string;
  scriptTests: readonly string[];
}): string[][] => [
  ["bun", "run", "generate"],
  [
    "bun",
    "scripts/code-check-affected.ts",
    "--base",
    base,
    "--skip-full-fallback",
  ],
  ...(scriptTests.length === 0
    ? []
    : [["bun", "test", "--timeout", SCRIPT_TEST_TIMEOUT_MS, ...scriptTests]]),
];

const changedPaths = (base: string): string[] => {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0
      ? result.stdout.toString()
      : panic(
          `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
        );
  };
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  return git([
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=d",
    mergeBase,
    "HEAD",
  ])
    .split("\0")
    .filter((file) => file !== "");
};

const main = (): number => {
  const options = parsePrePushArgs(process.argv.slice(2));
  const changed = changedPaths(options.base);
  if (changed.length === 0) {
    process.stdout.write("pre-push affected: no changes against the base\n");
    return 0;
  }
  const commands = prePushCommands({
    base: options.base,
    scriptTests: rootScriptTests(changed, (file) =>
      existsSync(path.join(REPO_ROOT, file)),
    ),
  });
  for (const command of commands) {
    process.stdout.write(`pre-push affected: ${command.join(" ")}\n`);
    if (options.dryRun) {
      continue;
    }
    const result = Bun.spawnSync(command, {
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, CODE_CHECK_CONCURRENCY: "1" },
    });
    const status = childExitStatus(result);
    if (status !== 0) {
      process.stderr.write(
        `pre-push affected: failed: ${command.join(" ")}\nCI runs the same check; fix it before pushing.\n`,
      );
      return status;
    }
  }
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
