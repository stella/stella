// Design-system lint backlog guard.
//
// `oxlint.config.ts` enables the tracked design rules (the `@shadcn/lint` pair
// plus the local `no-raw-overflow-scroll` and `no-imported-class-constant`) for
// every file except the ones this baseline lists per rule
// (scripts/design-lint-policy.ts turns the rule off there). Those files carry
// merged-code debt; this guard holds each file's count at its baseline by
// running the rule-only pass (`oxlint.design.config.ts`) over them. A rise
// fails, a file that reaches zero fails until it is pruned (an override on a
// clean file would hide the next finding), and a fall just prompts a
// regeneration so the list keeps shrinking.
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
const WRITE_HINT = "bun scripts/design-lint-baseline.ts --write";
/** Cap the stale list so a large prune stays readable in CI logs. */
const STALE_PREVIEW = 10;
/** oxlint --format=json reports every rule as `plugin(rule)`. */
const DIAGNOSTIC_CODE = /^(?<plugin>[a-z0-9-]+)\((?<rule>[a-z0-9-]+)\)$/u;

const LintOutput = v.object({
  diagnostics: v.array(v.object({ code: v.string(), filename: v.string() })),
});

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

const emptyBacklog = (): DesignLintBacklog => ({
  "shadcn/no-arbitrary-values": {},
  "shadcn/no-restyle": {},
  "no-raw-overflow-scroll/no-raw-overflow-scroll": {},
  "no-imported-class-constant/no-imported-class-constant": {},
});

const sortedCounts = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );

const lint = (paths: readonly string[]): DesignLintBacklog => {
  // The report runs to megabytes; a piped stdout is cut off at the pipe
  // buffer once the child exits non-zero, so it goes through a file.
  const reportDirectory = mkdtempSync(path.join(tmpdir(), "design-lint-"));
  const reportPath = path.join(reportDirectory, "report.json");
  const result = Bun.spawnSync(
    ["bun", "--bun", "oxlint", "-c", CONFIG_PATH, "--format=json", ...paths],
    { stdout: Bun.file(reportPath), stderr: "pipe" },
  );
  const report = readFileSync(reportPath, "utf-8");
  rmSync(reportDirectory, { recursive: true, force: true });
  // Exit code 1 is "findings reported"; anything else is a broken run.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(
      `oxlint -c ${CONFIG_PATH} exited with ${result.exitCode}:\n${result.stderr.toString()}`,
    );
  }
  const output = v.parse(LintOutput, JSON.parse(report));
  const backlog = emptyBacklog();
  for (const { code, filename } of output.diagnostics) {
    const rule = backlogRule(code);
    if (rule === undefined) {
      continue;
    }
    backlog[rule][filename] = (backlog[rule][filename] ?? 0) + 1;
  }
  for (const rule of DESIGN_LINT_BACKLOG_RULES) {
    backlog[rule] = sortedCounts(backlog[rule]);
  }
  return backlog;
};

const readBaseline = (): DesignLintBacklog =>
  JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

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

const total = (backlog: DesignLintBacklog, rule: DesignLintBacklogRule) =>
  Object.values(backlog[rule]).reduce((sum, count) => sum + count, 0);

const run = (): number => {
  let mode = "report";
  if (process.argv.includes("--write")) {
    mode = "write";
  } else if (process.argv.includes("--check")) {
    mode = "check";
  }

  if (mode === "write") {
    const current = lint(LINT_SCOPE);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    for (const rule of DESIGN_LINT_BACKLOG_RULES) {
      console.log(
        `${rule}: ${total(current, rule)} findings in ${Object.keys(current[rule]).length} files`,
      );
    }
    console.log(`Wrote ${BASELINE_PATH}`);
    return 0;
  }

  const baseline = readBaseline();
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

  if (regressed.length === 0 && stale.length === 0) {
    console.log(
      `OK: design-system backlog holds across ${files.length} files.`,
    );
    if (improved.length > 0) {
      console.log(
        `${improved.length} file(s) improved; run \`${WRITE_HINT}\` to lock the improvement in.`,
      );
    }
    return 0;
  }

  if (regressed.length > 0) {
    console.error("\nDesign-system findings rose in backlog file(s):");
    for (const entry of regressed) {
      console.error(`  ${entry}`);
    }
    console.error(
      "\nThe rule is off in these files only for the findings already there.\n" +
        "Fix the new finding: `bun --bun oxlint -c oxlint.design.config.ts <file>`\n" +
        "names the variant, size, token, or primitive to use.",
    );
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} backlog entr${stale.length === 1 ? "y" : "ies"} no longer carr${stale.length === 1 ? "ies" : "y"} findings:`,
    );
    for (const entry of stale.slice(0, STALE_PREVIEW)) {
      console.error(`  ${entry}`);
    }
    if (stale.length > STALE_PREVIEW) {
      console.error(`  ... and ${stale.length - STALE_PREVIEW} more`);
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
