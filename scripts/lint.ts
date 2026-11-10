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
  const child = Bun.spawn(command, {
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  await child.exited;
  if (child.signalCode !== null) {
    // Die the way the linter did, so a caller sees the same termination.
    for (const signal of FORWARDED_SIGNALS) {
      process.removeAllListeners(signal);
    }
    process.kill(process.pid, child.signalCode);
  }
  process.exit(childExitStatus(child));
}
