#!/usr/bin/env bun
/**
 * The one entry point every repository lint goes through.
 *
 * Workspace `lint` / `lint:fix` scripts, the root lint scripts, the
 * pre-commit fix pass, `lint:changed`, the root-script lint and the narrow
 * passes over the design, result-boundary and Tailwind configs all build
 * their linter command here. Callers name only what they lint (paths) and any
 * extra linter flags; this file owns the linter binary, the config files and
 * the flags every lint shares. Swapping the linter is an edit to `LINTER`
 * below and nothing else.
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

import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

// ---------------------------------------------------------------------------
// THE LINTER. This block is the single place that chooses which linter runs
// and how its shared flags are spelled; nothing else in the repository names
// the binary for a lint run. To move to another linter (for example Bun's
// built-in `bun lint` once it ships), change `command`, `entry` and the flag
// spellings here, then check `bun scripts/lint.ts --dry-run <path>`.
// ---------------------------------------------------------------------------
const LINTER = {
  /** How a lint run starts the linter. */
  command: ["bun", "--bun", "oxlint"],
  /**
   * The linter's own entry file, for a caller that must run it in its own
   * Bun runtime rather than under a wrapper process (see `inProcess`).
   */
  entry: "node_modules/oxlint/bin/oxlint",
  config: (file: string) => ["-c", file],
  unusedDirectives: "--report-unused-disable-directives-severity=error",
  typeAware: "--type-aware",
  typeCheck: "--type-check",
  fix: "--fix",
} as const;

/** The repository's lint configs, by the name callers pass. */
export const LINT_CONFIGS = {
  main: "oxlint.config.ts",
  design: "oxlint.design.config.ts",
  "result-boundary": "oxlint.result-boundary.config.ts",
  tailwind: "oxlint.tailwind.config.ts",
} as const;
export type LintConfig = keyof typeof LINT_CONFIGS;

/**
 * Which shared flags a run carries:
 * - `check`: the full check every workspace `lint` runs (unused disable
 *   directives are errors, type-aware rules, type check).
 * - `fix`: the `lint:fix` pass (type-aware rules, apply fixes).
 * - `config-only`: only the config; the narrow design, result-boundary and
 *   Tailwind passes run this way.
 */
export type LintMode = "check" | "fix" | "config-only";

export type LintOptions = {
  /** Defaults to `main`. */
  config?: LintConfig;
  /** Defaults to `check` for the main config and `config-only` otherwise. */
  mode?: LintMode;
  /** `false` drops the type-aware rules and the type check. */
  typeAware?: boolean;
  /** `false` keeps the type-aware rules and drops the type check. */
  typeCheck?: boolean;
  /**
   * Start the linter's entry file under this Bun process's own runtime,
   * resolved from `root`, instead of through a wrapper process. A caller that
   * enforces a timeout needs this so killing the child kills the linter.
   */
  inProcess?: { root: string };
};

/** The linter command for one run: shared flags, then `args` in order. */
export const lintCommand = (
  {
    config = "main",
    mode = config === "main" ? "check" : "config-only",
    typeAware = true,
    typeCheck = true,
    inProcess,
  }: LintOptions = {},
  args: readonly string[] = [],
): string[] => {
  const runsTypeAware = mode !== "config-only" && typeAware;
  return [
    ...(inProcess === undefined
      ? LINTER.command
      : [process.execPath, path.join(inProcess.root, LINTER.entry)]),
    ...LINTER.config(LINT_CONFIGS[config]),
    ...(mode === "check" ? [LINTER.unusedDirectives] : []),
    ...(runsTypeAware ? [LINTER.typeAware] : []),
    ...(runsTypeAware && mode === "check" && typeCheck
      ? [LINTER.typeCheck]
      : []),
    ...(mode === "fix" ? [LINTER.fix] : []),
    ...args,
  ];
};

const isLintConfig = (name: string): name is LintConfig =>
  Object.hasOwn(LINT_CONFIGS, name);

export type LintInvocation = {
  options: LintOptions;
  args: string[];
  dryRun: boolean;
};

/** Splits the leading entry options from the arguments the linter gets. */
export const parseLintArguments = (
  argv: readonly string[],
): LintInvocation | { error: string } => {
  const options: LintOptions = {};
  let dryRun = false;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--") {
      index += 1;
      break;
    }
    if (argument.startsWith("--config=")) {
      const name = argument.slice("--config=".length);
      if (!isLintConfig(name)) {
        return {
          error: `unknown lint config "${name}"; expected one of ${Object.keys(LINT_CONFIGS).join(", ")}`,
        };
      }
      options.config = name;
    } else if (argument === "--fix") {
      options.mode = "fix";
    } else if (argument === "--no-type-check") {
      options.typeCheck = false;
    } else if (argument === "--no-type-aware") {
      options.typeAware = false;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else {
      break;
    }
  }
  return { options, args: argv.slice(index), dryRun };
};

const SHELL_SAFE = /^[\w@%+=:,./-]+$/u;
const shellQuote = (part: string) =>
  SHELL_SAFE.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`;

/** The command as one shell line, the form `--dry-run` prints. */
export const formatLintCommand = (command: readonly string[]): string =>
  command.map(shellQuote).join(" ");

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
