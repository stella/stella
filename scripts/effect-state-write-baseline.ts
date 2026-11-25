// Per-file counts of `no-effect-state-write` findings that predate the rule
// (.oxlint-plugins/no-effect-state-write-baseline.json). The rule reports a
// file's findings past its count; this script measures the counts by running
// the rule in census mode and holds them to shrink-only, like the SQL
// performance baseline.
//
//   bun scripts/effect-state-write-baseline.ts --check     exact counts; with
//                                                         BASE_SHA, no growth
//   bun scripts/effect-state-write-baseline.ts --write     lower counts, drop
//                                                         clean files
import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS } from "../oxlint.config.ts";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { ruleCensusDiagnostics } from "./rule-census.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = BASELINE_PATHS.effectStateWrite;
const RULE = "no-effect-state-write";
// A finding needs a state hook and an effect hook in the same file.
const STATE_HOOK = /\buse(?:State|Reducer)\b/u;
const EFFECT_HOOK =
  /\buse(?:Effect|LayoutEffect|InsertionEffect|IsomorphicLayoutEffect|MountEffect|ExternalSyncEffect)\b/u;
const isCandidate = (source: string): boolean =>
  STATE_HOOK.test(source) && EFFECT_HOOK.test(source);

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

const census = (): Counts => {
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--",
      ...NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS.flatMap((directory) => [
        `:(glob)${directory}/**/*.ts`,
        `:(glob)${directory}/**/*.tsx`,
      ]),
    ],
    { cwd: ROOT },
  );
  if (listed.exitCode !== 0) {
    panic("Cannot enumerate effect state write source files");
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
    rule: RULE,
    files,
    lintTarget: ".",
    label: "effect-state-write",
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

const baseCounts = (base: string): Counts | null => {
  const result = Bun.spawnSync(["git", "show", `${base}:${BASELINE}`], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0
    ? parseCounts(result.stdout.toString(), `${base}:${BASELINE}`)
    : null;
};

const main = (): number => {
  const recorded = parseCounts(
    readFileSync(path.join(ROOT, BASELINE), "utf-8"),
    BASELINE,
  );
  const current = census();
  if (process.argv.includes("--write")) {
    const increases = raised(current, recorded);
    if (increases.length > 0) {
      console.error(
        `Refusing to raise effect state write counts:\n${format(increases)}`,
      );
      return 1;
    }
    writeFileSync(path.join(ROOT, BASELINE), serialize(current));
    console.log(`Wrote effect state write counts to ${BASELINE}`);
    return 0;
  }
  const issues = mismatches(current, recorded);
  if (issues.length > 0) {
    console.error(
      `Effect state write baseline mismatch (lower counts with --write; a rise needs the fix, not a count):\n${format(issues)}`,
    );
    return 1;
  }
  const base = process.env["BASE_SHA"];
  const committed = base ? baseCounts(base) : null;
  if (committed !== null) {
    const grown = raised(recorded, committed);
    if (grown.length > 0) {
      console.error(
        `Effect state write baseline raises counts from ${String(base)}:\n${format(grown)}`,
      );
      return 1;
    }
  }
  console.log(
    `Effect state write baseline: ${String(current.size)} files match.`,
  );
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
