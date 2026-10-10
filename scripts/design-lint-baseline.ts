// Design-system lint backlog guard.
//
// `oxlint.config.ts` enables the tracked rules (the `@shadcn/lint` pair, the
// local `no-raw-overflow-scroll` and `no-imported-class-constant`, the API
// size-bound rules `require-bounded-request-schema` and
// `no-unbounded-response-body`, `no-computed-key-record-assignment`, and the
// function size limits `complexity`,
// `max-lines-per-function` and `max-params`) for every file in their scope
// except the ones this baseline lists per rule (scripts/design-lint-policy.ts
// turns the rule off there, or down to its ceiling for a size limit). Those files carry merged-code debt; this guard holds each file's
// count at its baseline by running the rule-only pass
// (`oxlint.design.config.ts`) over them. A rise fails, a file that reaches
// zero fails until it is pruned (an override on a clean file would hide the
// next finding), and a fall fails until the baseline is regenerated: a count
// left above the tree's would let that file regress back up unnoticed.
//
// The file is a function of the tracked tree alone: findings in untracked
// files are dropped, paths are repository-relative POSIX, rules follow
// DESIGN_LINT_BACKLOG_RULES and files sort by code unit, so `--write` gives
// the same bytes on every machine and `--check` rejects any other layout.
//
// Modes:
//   bun scripts/design-lint-baseline.ts          report per-rule counts vs baseline
//   bun scripts/design-lint-baseline.ts --check  CI gate (exit 1 on a rise or a stale file)
//   bun scripts/design-lint-baseline.ts --write  regenerate the baseline from the lint scope
//
// Wired into .github/workflows/ci.yml and scripts/verify.sh beside the other
// baseline guards.

import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";

import { BASELINE_PATHS } from "./baseline-paths";
import {
  DESIGN_LINT_BACKLOG_RULES,
  DESIGN_LINT_RULE_BY_DIAGNOSTIC_CODE,
  DESIGN_LINT_TRACKED_PLUGINS,
  type DesignLintBacklog,
  type DesignLintBacklogRule,
} from "./design-lint-policy.ts";

const BASELINE_PATH = BASELINE_PATHS.designLint;
const CONFIG_PATH = "oxlint.design.config.ts";
/** The paths `code-check` lints; the baseline is measured on the same tree. */
const LINT_SCOPE = [".claude/mcp", "apps", "packages"];
/**
 * The files `lint-root-scripts.sh` and `lint-oxlint-fixtures.sh` lint with the
 * same config, listed from git for the reason those scripts give. The
 * fixtures break rules on purpose and are linted on their own.
 */
const TOOLING_PATHSPECS = [
  "scripts/*.ts",
  ".oxlint-plugins/*.ts",
  ":(exclude).oxlint-plugins/__fixtures__/**",
];

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");

const gitFiles = (pathspecs: readonly string[]): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "--", ...pathspecs], {
    cwd: REPOSITORY_ROOT,
  });
  if (result.exitCode !== 0) {
    panic(`git ls-files exited with ${result.exitCode}`);
  }
  return result.stdout.toString().split("\n").filter(Boolean);
};
const WRITE_HINT = "bun scripts/design-lint-baseline.ts --write";
/** Cap each entry list so a large prune stays readable in CI logs. */
const ENTRY_PREVIEW = 10;
/** oxlint --format=json reports every rule as `plugin(rule)`. */
const DIAGNOSTIC_CODE = /^(?<plugin>[a-z0-9-]+)\((?<rule>[a-z0-9-]+)\)$/u;

const LintDiagnostic = v.object({ code: v.string(), filename: v.string() });
const LintOutput = v.object({ diagnostics: v.array(LintDiagnostic) });

/**
 * The tracked rule a diagnostic belongs to, or undefined for a plugin this
 * baseline does not track. A code from a tracked plugin that maps to nothing
 * is a rule enabled in the measuring pass without a ratchet decision: dropping
 * it would silently under-count the backlog, so it stops the run.
 */
const backlogRule = (code: string): DesignLintBacklogRule | undefined => {
  const rule = DESIGN_LINT_RULE_BY_DIAGNOSTIC_CODE.get(code);
  if (rule !== undefined) {
    return rule;
  }
  const plugin = DIAGNOSTIC_CODE.exec(code)?.groups?.["plugin"];
  if (plugin !== undefined && DESIGN_LINT_TRACKED_PLUGINS.has(plugin)) {
    panic(
      `${CONFIG_PATH} reported \`${code}\`, which scripts/design-lint-policy.ts does not track. ` +
        "Add it to DESIGN_LINT_BACKLOG_RULES or turn it off in DESIGN_LINT_MEASURED_RULES.",
    );
  }
  return undefined;
};

export const emptyBacklog = (): DesignLintBacklog => ({
  "shadcn/no-arbitrary-values": {},
  "shadcn/no-restyle": {},
  "no-raw-overflow-scroll/no-raw-overflow-scroll": {},
  "no-imported-class-constant/no-imported-class-constant": {},
  "require-bounded-request-schema/require-bounded-request-schema": {},
  "no-unbounded-response-body/no-unbounded-response-body": {},
  "no-computed-key-record-assignment/no-computed-key-record-assignment": {},
  "no-direct-status-set/no-direct-status-set": {},
  "eslint/complexity": {},
  "eslint/max-lines-per-function": {},
  "eslint/max-params": {},
  "react/no-children-prop": {},
  "eslint/no-unexpected-multiline": {},
});

/** A repository-relative POSIX path, whichever form oxlint printed. */
const repositoryPath = (filename: string): string =>
  repoRelativePath(REPOSITORY_ROOT, path.resolve(REPOSITORY_ROOT, filename))
    .split(path.sep)
    .join("/");

/**
 * Per-file counts from a lint report, keyed by repository path. Only tracked
 * files count: a directory walk also reaches whatever untracked files a
 * checkout holds, which would make the baseline depend on the machine.
 */
export const backlogFromDiagnostics = (
  diagnostics: readonly v.InferOutput<typeof LintDiagnostic>[],
  trackedFiles: ReadonlySet<string>,
): DesignLintBacklog => {
  const backlog = emptyBacklog();
  for (const { code, filename } of diagnostics) {
    const rule = backlogRule(code);
    const file = repositoryPath(filename);
    if (rule === undefined || !trackedFiles.has(file)) {
      continue;
    }
    backlog[rule][file] = (backlog[rule][file] ?? 0) + 1;
  }
  return backlog;
};

/**
 * The baseline's one byte form: rules in DESIGN_LINT_BACKLOG_RULES order,
 * files in code-unit order, whatever order the lint run reported them in.
 */
export const serializeBacklog = (backlog: DesignLintBacklog): string => {
  const canonical = DESIGN_LINT_BACKLOG_RULES.map((rule) => [
    rule,
    Object.fromEntries(
      Object.entries(backlog[rule]).toSorted(([left], [right]) =>
        compareCodeUnit(left, right),
      ),
    ),
  ]);
  return `${JSON.stringify(Object.fromEntries(canonical), null, 2)}\n`;
};

const lint = (paths: readonly string[]): DesignLintBacklog => {
  // The report runs to megabytes; a piped stdout is cut off at the pipe
  // buffer once the child exits non-zero, so it goes through a file.
  const reportDirectory = mkdtempSync(path.join(tmpdir(), "design-lint-"));
  const reportPath = path.join(reportDirectory, "report.json");
  const result = Bun.spawnSync(
    ["bun", "--bun", "oxlint", "-c", CONFIG_PATH, "--format=json", ...paths],
    { cwd: REPOSITORY_ROOT, stdout: Bun.file(reportPath), stderr: "pipe" },
  );
  const report = readFileSync(reportPath, "utf-8");
  rmSync(reportDirectory, { recursive: true, force: true });
  // Exit code 1 is "findings reported"; anything else is a broken run.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(
      `oxlint -c ${CONFIG_PATH} exited with ${result.exitCode}:\n${result.stderr.toString()}`,
    );
  }
  const { diagnostics } = v.parse(LintOutput, JSON.parse(report));
  return backlogFromDiagnostics(
    diagnostics,
    new Set(gitFiles([...LINT_SCOPE, ...TOOLING_PATHSPECS])),
  );
};

const baselineFiles = (baseline: DesignLintBacklog): string[] => [
  ...new Set(
    DESIGN_LINT_BACKLOG_RULES.flatMap((rule) => Object.keys(baseline[rule])),
  ),
];

type BacklogDiff = { improved: string[]; regressed: string[]; stale: string[] };

/** Compare the counts measured on the baseline's files against the baseline. */
export const diffDesignBacklog = (
  current: DesignLintBacklog,
  baseline: DesignLintBacklog,
): BacklogDiff => {
  const diff: BacklogDiff = { improved: [], regressed: [], stale: [] };
  for (const rule of DESIGN_LINT_BACKLOG_RULES) {
    for (const [file, budget] of Object.entries(baseline[rule])) {
      const count = current[rule][file] ?? 0;
      const entry = `${rule} ${file} (${count}, baseline ${budget})`;
      if (count > budget) {
        diff.regressed.push(entry);
      } else if (count === 0) {
        diff.stale.push(entry);
      } else if (count < budget) {
        diff.improved.push(entry);
      }
    }
  }
  return diff;
};

/**
 * Whether the baseline equals what its files carry. A fall counts as drift
 * like a rise does: a budget left above the tree's count lets that file
 * regress back up to it unnoticed.
 */
export const isBacklogCurrent = ({
  improved,
  regressed,
  stale,
}: BacklogDiff): boolean =>
  improved.length === 0 && regressed.length === 0 && stale.length === 0;

const total = (backlog: DesignLintBacklog, rule: DesignLintBacklogRule) =>
  Object.values(backlog[rule]).reduce((sum, count) => sum + count, 0);

const run = (): number => {
  let mode = "report";
  if (process.argv.includes("--write")) {
    mode = "write";
  } else if (process.argv.includes("--check")) {
    mode = "check";
  }

  const baselinePath = path.join(REPOSITORY_ROOT, BASELINE_PATH);
  if (mode === "write") {
    const current = lint([...LINT_SCOPE, ...gitFiles(TOOLING_PATHSPECS)]);
    writeFileSync(baselinePath, serializeBacklog(current));
    for (const rule of DESIGN_LINT_BACKLOG_RULES) {
      console.log(
        `${rule}: ${total(current, rule)} findings in ${Object.keys(current[rule]).length} files`,
      );
    }
    console.log(`Wrote ${BASELINE_PATH}`);
    return 0;
  }

  const committed = readFileSync(baselinePath, "utf-8");
  const baseline: DesignLintBacklog = JSON.parse(committed);
  const files = baselineFiles(baseline);
  const current = files.length === 0 ? emptyBacklog() : lint(files);
  const { improved, regressed, stale } = diffDesignBacklog(current, baseline);

  if (mode === "report") {
    for (const rule of DESIGN_LINT_BACKLOG_RULES) {
      console.log(
        `${rule}: ${total(current, rule)} findings (baseline ${total(baseline, rule)}) in ${Object.keys(baseline[rule]).length} files`,
      );
    }
    for (const entry of [...regressed, ...stale, ...improved]) {
      console.log(`  ${entry}`);
    }
    return 0;
  }

  const canonical = serializeBacklog(baseline) === committed;
  if (isBacklogCurrent({ improved, regressed, stale }) && canonical) {
    console.log(`OK: lint backlog holds across ${files.length} files.`);
    return 0;
  }

  if (!canonical) {
    console.error(
      `\n${BASELINE_PATH} is not in the generated order. Run \`${WRITE_HINT}\`.`,
    );
  }
  if (improved.length > 0) {
    console.error(
      `\nLint findings fell in ${improved.length} backlog entr${improved.length === 1 ? "y" : "ies"}:`,
    );
    for (const entry of improved.slice(0, ENTRY_PREVIEW)) {
      console.error(`  ${entry}`);
    }
    if (improved.length > ENTRY_PREVIEW) {
      console.error(`  ... and ${improved.length - ENTRY_PREVIEW} more`);
    }
    console.error(
      `\nA count above the tree's would let the file regress unnoticed.\n` +
        `Run \`${WRITE_HINT}\` and commit the baseline.`,
    );
  }

  if (regressed.length > 0) {
    console.error("\nLint findings rose in backlog file(s):");
    for (const entry of regressed) {
      console.error(`  ${entry}`);
    }
    console.error(
      "\nThe rule is off in these files only for the findings already there.\n" +
        "Fix the new finding: `bun --bun oxlint -c oxlint.design.config.ts <file>`\n" +
        "names the replacement to use, or the function to split.",
    );
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} backlog entr${stale.length === 1 ? "y" : "ies"} no longer carr${stale.length === 1 ? "ies" : "y"} findings:`,
    );
    for (const entry of stale.slice(0, ENTRY_PREVIEW)) {
      console.error(`  ${entry}`);
    }
    if (stale.length > ENTRY_PREVIEW) {
      console.error(`  ... and ${stale.length - ENTRY_PREVIEW} more`);
    }
    console.error(
      `\nA clean file must leave the backlog so the rule covers it in full.\n` +
        `Run \`${WRITE_HINT}\` and commit the baseline.`,
    );
  }
  return 1;
};

if (import.meta.main) {
  process.exit(run());
}
