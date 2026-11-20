/**
 * The linter command every repository lint runs, built in one place.
 *
 * `scripts/lint.ts` is the entry point package and shell scripts call; it
 * starts what `lintCommand` returns. TypeScript callers (the pre-commit fix
 * pass, `lint:changed`, the root-script lint, the design, result-boundary and
 * Tailwind passes) import `lintCommand` directly and spawn the result
 * themselves. This module only builds commands and never starts a process, so
 * offline checks may import it.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// THE LINTER. This block is the single place that chooses which linter runs
// and how its shared flags are spelled; nothing else in the repository names
// the binary for a lint run. To move to another linter (for example Bun's
// built-in `bun lint` once it ships), change `command`, `entry` and the flag
// spellings here, then check `bun scripts/lint.ts --dry-run <path>`. Package scripts, shell
// scripts and TypeScript callers all reach the linter through this file.
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
