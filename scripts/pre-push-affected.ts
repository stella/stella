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
//   3. the tests of changed root scripts;
//   4. the dead-export budget (one repository-wide knip run, about 20 s),
//      when a source file or the knip budget itself changed. Deleting a
//      call can leave an export unused, so any source change counts.
//
// The repository's own pre-push hook stays lightweight (see
// scripts/pre-push-policy.test.ts). A host-level hook runs this only when the
// machine has memory headroom, and CI still runs every check.
//
// Exit status: 0 the checks passed, 1 a check failed (block the push), 2 the
// checks could not run: no base ref, or the 10-minute total time cap ran out.
// A hook allows the push on 2, since CI runs the same checks. The last line
// reports the elapsed time and the highest peak resident memory among the
// commands this script starts directly; their descendants (Turbo tasks, lint
// and typecheck workers) are not included.
//
//   bun scripts/pre-push-affected.ts [--base origin/main] [--dry-run]

import { existsSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { BASELINE_PATHS } from "./baseline-paths";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";
/** Matches CI's root script test timeout. */
const SCRIPT_TEST_TIMEOUT_MS = "35000";
/** Total wall-clock cap for every command together. */
export const TOTAL_TIME_CAP_MS = 10 * 60_000;

export const PRE_PUSH_EXIT = {
  passed: 0,
  failed: 1,
  unavailable: 2,
} as const;

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

const KNIP_INPUT = /\.[cm]?[jt]sx?$|(?:^|\/)package\.json$/u;
const KNIP_BUDGET_FILES = new Set([
  "knip.json",
  BASELINE_PATHS.knipExports,
  "scripts/knip-exports-ratchet.ts",
]);

/** Whether a change can move the dead-export count CI budgets. */
export const knipBudgetAffected = (changedPaths: readonly string[]): boolean =>
  changedPaths.some(
    (file) => KNIP_INPUT.test(file) || KNIP_BUDGET_FILES.has(file),
  );

export const prePushCommands = ({
  base,
  scriptTests,
  knipBudget,
}: {
  base: string;
  scriptTests: readonly string[];
  knipBudget: boolean;
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
  ...(knipBudget ? [["bun", "run", "check:knip-exports"]] : []),
];

/**
 * Changed paths against the merge base, including deletions (deleting a module
 * that is still imported must still run the checks), or null when Git cannot
 * answer.
 */
export const changedPaths = (
  base: string,
  cwd = REPO_ROOT,
): string[] | null => {
  const git = (args: string[]): string | null => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      return result.stdout.toString();
    }
    process.stderr.write(
      `pre-push affected: git ${args.join(" ")} failed: ${result.stderr.toString().trim()}\n`,
    );
    return null;
  };
  const mergeBase = git(["merge-base", base, "HEAD"])?.trim();
  if (mergeBase === undefined) {
    return null;
  }
  const diff = git(["diff", "--name-only", "-z", mergeBase, "HEAD"]);
  return diff === null ? null : diff.split("\0").filter((file) => file !== "");
};

/** Every descendant of `root` in a `ps -A -o pid=,ppid=` snapshot, deepest last. */
export const descendantPids = (snapshot: string, root: number): number[] => {
  const children = new Map<number, number[]>();
  for (const line of snapshot.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
    if (
      pid === undefined ||
      ppid === undefined ||
      Number.isNaN(pid) ||
      Number.isNaN(ppid)
    ) {
      continue;
    }
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
};

/** Generators and Turbo start their own children, so a timeout stops the whole tree. */
const killProcessTree = (root: number) => {
  const snapshot = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();
  for (const pid of [root, ...descendantPids(snapshot, root)]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
};

export const runBounded = async (
  command: readonly string[],
  { timeoutMs, cwd = REPO_ROOT }: { timeoutMs: number; cwd?: string },
): Promise<{ status: number; timedOut: boolean; maxRssBytes: number }> => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, CODE_CHECK_CONCURRENCY: "1" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid);
  }, timeoutMs);
  await child.exited;
  clearTimeout(timer);
  return {
    status: childExitStatus(child),
    timedOut,
    maxRssBytes: child.resourceUsage()?.maxRSS ?? 0,
  };
};

const run = async (
  commands: readonly string[][],
  dryRun: boolean,
): Promise<{ status: number; peakRssBytes: number }> => {
  const deadline = Date.now() + TOTAL_TIME_CAP_MS;
  let peakRssBytes = 0;
  for (const command of commands) {
    process.stdout.write(`pre-push affected: ${command.join(" ")}\n`);
    if (dryRun) {
      continue;
    }
    const result = await runBounded(command, {
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    peakRssBytes = Math.max(peakRssBytes, result.maxRssBytes);
    if (result.timedOut) {
      process.stderr.write(
        `pre-push affected: the ${TOTAL_TIME_CAP_MS / 60_000}-minute time cap ran out during: ${command.join(" ")}\nCI runs the same checks.\n`,
      );
      return { status: PRE_PUSH_EXIT.unavailable, peakRssBytes };
    }
    if (result.status !== 0) {
      process.stderr.write(
        `pre-push affected: failed: ${command.join(" ")}\nCI runs the same check; fix it before pushing.\n`,
      );
      return { status: PRE_PUSH_EXIT.failed, peakRssBytes };
    }
  }
  return { status: PRE_PUSH_EXIT.passed, peakRssBytes };
};

const main = async (): Promise<number> => {
  const startedAt = Date.now();
  const options = parsePrePushArgs(process.argv.slice(2));
  const changed = changedPaths(options.base);
  if (changed === null) {
    return PRE_PUSH_EXIT.unavailable;
  }
  if (changed.length === 0) {
    process.stdout.write("pre-push affected: no changes against the base\n");
    return PRE_PUSH_EXIT.passed;
  }
  const { status, peakRssBytes } = await run(
    prePushCommands({
      base: options.base,
      scriptTests: rootScriptTests(changed, (file) =>
        existsSync(path.join(REPO_ROOT, file)),
      ),
      knipBudget: knipBudgetAffected(changed),
    }),
    options.dryRun,
  );
  process.stdout.write(
    `pre-push affected: exit=${status} elapsed_s=${Math.round((Date.now() - startedAt) / 1000)} direct_child_peak_rss_mib=${Math.round(peakRssBytes / 1024 ** 2)}\n`,
  );
  return status;
};

if (import.meta.main) {
  process.exit(await main());
}
