// Per-file counts of a lint rule's findings that predate the rule. The rule
// reports a file's findings past its count (see no-render-phase-update and
// no-effect-state-write); this module measures the counts by running the rule
// in census mode and holds them to shrink-only, like the SQL performance
// baseline. Each rule's script names its rule, baseline and candidate files.
//
//   --check   exact counts; with BASE_SHA, no growth
//   --write   lower counts, drop clean files
import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { ruleCensusDiagnostics } from "./rule-census.ts";

const ROOT = path.resolve(import.meta.dir, "..");

export type RuleCountBaseline = {
  /** The rule id without its plugin prefix. */
  rule: string;
  /** Repository-relative path of the counts file. */
  baseline: string;
  /** Directories whose TypeScript files the rule governs. */
  governedPaths: readonly string[];
  /** Whether a file's source can hold a finding at all. */
  isCandidate: (source: string) => boolean;
  /** What the counts count, capitalised, for messages ("Render-phase update"). */
  label: string;
};

type Counts = ReadonlyMap<string, number>;

type CountIssue = {
  file: string;
  expected: number | null;
  actual: number | null;
};

const serialize = (counts: Counts): string =>
  `${JSON.stringify(
    Object.fromEntries(
      [...counts].toSorted(([left], [right]) => compareCodeUnit(left, right)),
    ),
    null,
    2,
  )}\n`;

const census = ({
  rule,
  governedPaths,
  isCandidate,
  label,
}: RuleCountBaseline): Counts => {
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--",
      ...governedPaths.flatMap((directory) => [
        `:(glob)${directory}/**/*.ts`,
        `:(glob)${directory}/**/*.tsx`,
      ]),
    ],
    { cwd: ROOT },
  );
  if (listed.exitCode !== 0) {
    panic(`Cannot enumerate ${label.toLowerCase()} source files`);
  }
  const files = listed.stdout
    .toString()
    .split("\n")
    .filter(
      (file) =>
        file !== "" &&
        !file.endsWith(".d.ts") &&
        isCandidate(readFileSync(path.join(ROOT, file), "utf-8")),
    );
  const counts = new Map<string, number>();
  for (const { filename } of ruleCensusDiagnostics({
    rule,
    files,
    lintTarget: ".",
    label: rule,
  })) {
    counts.set(filename, (counts.get(filename) ?? 0) + 1);
  }
  return counts;
};

const parseCounts = (text: string, label: string): Counts => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return panic(`${label} must be an object of per-file counts`);
  }
  const counts = new Map<string, number>();
  for (const [file, count] of Object.entries(value)) {
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return panic(`${label}: count for ${file} must be a positive integer`);
    }
    counts.set(file, count);
  }
  return counts;
};

/** Files whose count rose or that the recorded counts do not list. */
const raised = (current: Counts, recorded: Counts): CountIssue[] =>
  [...current]
    .filter(([file, actual]) => actual > (recorded.get(file) ?? 0))
    .map(([file, actual]) => ({
      file,
      expected: recorded.get(file) ?? null,
      actual,
    }));

const mismatches = (current: Counts, recorded: Counts): CountIssue[] =>
  [...new Set([...current.keys(), ...recorded.keys()])]
    .filter((file) => current.get(file) !== recorded.get(file))
    .toSorted(compareCodeUnit)
    .map((file) => ({
      file,
      expected: recorded.get(file) ?? null,
      actual: current.get(file) ?? null,
    }));

const format = (issues: readonly CountIssue[]): string =>
  issues
    .map(
      ({ file, expected, actual }) =>
        `${file}: ${String(expected ?? "missing")} -> ${String(actual ?? "none")}`,
    )
    .join("\n");

const baseCounts = (base: string, baseline: string): Counts | null => {
  const result = Bun.spawnSync(["git", "show", `${base}:${baseline}`], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0
    ? parseCounts(result.stdout.toString(), `${base}:${baseline}`)
    : null;
};

/** Runs the check or write the command line asks for; returns the exit code. */
export const runRuleCountBaseline = (config: RuleCountBaseline): number => {
  const { baseline, label } = config;
  const recorded = parseCounts(
    readFileSync(path.join(ROOT, baseline), "utf-8"),
    baseline,
  );
  const current = census(config);
  if (process.argv.includes("--write")) {
    const increases = raised(current, recorded);
    if (increases.length > 0) {
      console.error(
        `Refusing to raise ${label.toLowerCase()} counts:\n${format(increases)}`,
      );
      return 1;
    }
    writeFileSync(path.join(ROOT, baseline), serialize(current));
    console.log(`Wrote ${label.toLowerCase()} counts to ${baseline}`);
    return 0;
  }
  const issues = mismatches(current, recorded);
  if (issues.length > 0) {
    console.error(
      `${label} baseline mismatch (lower counts with --write; a rise needs the fix, not a count):\n${format(issues)}`,
    );
    return 1;
  }
  const base = process.env["BASE_SHA"];
  const committed = base ? baseCounts(base, baseline) : null;
  if (committed !== null) {
    const grown = raised(recorded, committed);
    if (grown.length > 0) {
      console.error(
        `${label} baseline raises counts from ${String(base)}:\n${format(grown)}`,
      );
      return 1;
    }
  }
  console.log(`${label} baseline: ${String(current.size)} files match.`);
  return 0;
};
