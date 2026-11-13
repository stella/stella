import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  formatLintCommand,
  lintCommand,
  type LintInvocation,
  parseLintArguments,
} from "./lint-command";

const ROOT = path.resolve(import.meta.dir, "..");

const commandFor = (argv: readonly string[]): string => {
  const parsed = parseLintArguments(argv);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return formatLintCommand(lintCommand(parsed.options, parsed.args));
};

// Each pair is a lint command as package scripts and shell scripts spelled it
// before the entry script existed, and the entry-script arguments that
// replace it. The entry script must start exactly the old command.
const EQUIVALENT_COMMANDS: readonly [string, readonly string[]][] = [
  [
    "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --type-check packages/errors",
    ["packages/errors"],
  ],
  [
    "bun --bun oxlint -c oxlint.config.ts --type-aware --fix packages/errors",
    ["--fix", "packages/errors"],
  ],
  [
    "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --type-check apps/landing/astro.config.mjs apps/landing/src",
    ["apps/landing/astro.config.mjs", "apps/landing/src"],
  ],
  [
    "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --type-check --ignore-pattern 'apps/api/src/lib/**' apps/api",
    ["--ignore-pattern", "apps/api/src/lib/**", "apps/api"],
  ],
  [
    "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --debug timings --format=default apps/web",
    ["--no-type-check", "--debug", "timings", "--format=default", "apps/web"],
  ],
  [
    "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error .claude/mcp/doc-sources.ts",
    ["--no-type-aware", ".claude/mcp/doc-sources.ts"],
  ],
  [
    "bun --bun oxlint -c oxlint.design.config.ts packages/ui/src/button.tsx",
    ["--config=design", "packages/ui/src/button.tsx"],
  ],
  [
    "bun --bun oxlint -c oxlint.result-boundary.config.ts --deny-warnings apps/api/src/lib/a.ts",
    ["--config=result-boundary", "--deny-warnings", "apps/api/src/lib/a.ts"],
  ],
];

describe("lint entry script", () => {
  test.each(EQUIVALENT_COMMANDS)("starts %s", (expected, argv) => {
    expect(commandFor(argv)).toBe(expected);
  });

  test("hands everything after the first linter argument to the linter", () => {
    // `bun run lint --fix` in a workspace appends `--fix` after the paths;
    // it reaches the linter on top of the full check, not as the fix pass.
    expect(commandFor(["packages/errors", "--fix"])).toBe(
      "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --type-check packages/errors --fix",
    );
    expect(commandFor(["--", "--fix"])).toBe(
      "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --type-check --fix",
    );
  });

  test("reads --dry-run and rejects an unknown config", () => {
    const parsed: LintInvocation | { error: string } = parseLintArguments([
      "--dry-run",
      "packages/errors",
    ]);
    expect(parsed).toEqual({
      options: {},
      args: ["packages/errors"],
      dryRun: true,
    });
    expect(parseLintArguments(["--config=nope", "a.ts"])).toEqual({
      error:
        'unknown lint config "nope"; expected one of main, design, result-boundary, tailwind',
    });
  });

  test("builds the in-process command for the Tailwind pass", () => {
    expect(
      lintCommand({ config: "tailwind", inProcess: { root: ROOT } }, [
        "--format",
        "json",
        "apps/web",
      ]),
    ).toEqual([
      process.execPath,
      path.join(ROOT, "node_modules/oxlint/bin/oxlint"),
      "-c",
      "oxlint.tailwind.config.ts",
      "--format",
      "json",
      "apps/web",
    ]);
  });

  test("the pre-commit fix pass carries only the config and --fix", () => {
    expect(
      lintCommand({ mode: "fix", typeAware: false }, ["--threads=2", "a.ts"]),
    ).toEqual([
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--fix",
      "--threads=2",
      "a.ts",
    ]);
  });

  test("--dry-run prints the command without running the linter", () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/lint.ts", "--dry-run", "packages/errors"],
      { cwd: ROOT },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --type-aware --type-check packages/errors\n",
    );
  });

  test("refuses an unknown config before starting the linter", () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/lint.ts", "--config=nope", "packages/errors"],
      { cwd: ROOT, stderr: "pipe" },
    );
    expect(result.exitCode).toBe(2);
  });
});
