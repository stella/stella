#!/usr/bin/env bun
/**
 * The one entry point every repository lint goes through.
 *
 * Workspace `lint` / `lint:fix` scripts, the root lint scripts, the
 * pre-commit fix pass, `lint:changed`, the root-script lint and the narrow
 * passes over the design, result-boundary and Tailwind configs all run the
 * command `scripts/lint-command.ts` builds. Callers name only what they lint
 * (paths) and any extra linter flags; that module owns the linter binary, the
 * config files and the flags every lint shares, so swapping the linter is an
 * edit to its `LINTER` block and nothing else.
 *
 * Run from the repository root (workspace scripts `cd ../..` first):
 *
 *   bun scripts/lint.ts [options] [linter arguments...]
 *
 * Options come first; the first argument that is not one (or `--`) ends
 * them, and it and everything after it go to the linter unchanged and in
 * order. So `bun run lint --fix` in a workspace still hands `--fix` to the
 * linter on top of the full check, exactly as before.
 *
 *   --config=<name>   main (default), design, result-boundary or tailwind
 *   --fix             the fix pass (the `lint:fix` shape)
 *   --no-type-check   keep the type-aware rules, skip the type check
 *   --no-type-aware   no type-aware rules and no type check
 *   --dry-run         print the command instead of running it; setting
 *                     STELLA_LINT_DRY_RUN=1 does the same through a package
 *                     script
 *
 * The linter runs in the caller's working directory with the caller's
 * environment (`GOMEMLIMIT` and the like reach it), its output goes straight
 * to the terminal, and this process exits with the linter's exit code.
 */

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import {
  formatLintCommand,
  lintCommand,
  parseLintArguments,
} from "./lint-command";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const CRASH_SIGNALS = new Set<string>(["SIGSEGV", "SIGBUS", "SIGABRT"]);
// 128 + SIGABRT(6), SIGBUS(7), SIGSEGV(11): wrapper exit codes when the child dies by crash signal.
const CRASH_EXIT_CODES = new Set<number>([134, 135, 139]);

export type LintRunOutcome = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

/** True only for fatal native runtime crashes, never for normal lint findings (exit 1). */
export const isRuntimeCrashOutcome = (outcome: LintRunOutcome): boolean =>
  (outcome.signalCode !== null && CRASH_SIGNALS.has(outcome.signalCode)) ||
  (outcome.exitCode !== null && CRASH_EXIT_CODES.has(outcome.exitCode));

const describeCrash = (outcome: LintRunOutcome): string =>
  outcome.signalCode !== null
    ? `signal ${outcome.signalCode}`
    : `exit ${String(outcome.exitCode)}`;

/**
 * Runs the linter once, retrying a single time if the runtime itself crashes
 * (SIGSEGV/SIGBUS/SIGABRT). Normal lint failures (exit 1) never retry.
 */
export const runWithCrashRetry = async (
  execute: () => Promise<LintRunOutcome>,
  warn: (message: string) => void = (message) => {
    console.error(message);
  },
): Promise<LintRunOutcome> => {
  const first = await execute();
  if (!isRuntimeCrashOutcome(first)) {
    return first;
  }
  warn(
    `::warning::lint: linter terminated by runtime crash (${describeCrash(first)}); retrying once (attempt 2/2)`,
  );
  return await execute();
};

const spawnLintOnce = async (
  command: readonly string[],
): Promise<LintRunOutcome> => {
  const child = Bun.spawn([...command], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    await child.exited;
    return {
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  } finally {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  }
};

if (import.meta.main) {
  const parsed = parseLintArguments(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`lint: ${parsed.error}`);
    process.exit(2);
  }
  const command = lintCommand(parsed.options, parsed.args);
  if (parsed.dryRun || process.env["STELLA_LINT_DRY_RUN"] === "1") {
    console.log(formatLintCommand(command));
    process.exit(0);
  }
  const outcome = await runWithCrashRetry(() => spawnLintOnce(command));
  if (outcome.signalCode !== null) {
    // Die the way the linter did, so a caller sees the same termination.
    process.kill(process.pid, outcome.signalCode);
  }
  process.exit(childExitStatus(outcome));
}
