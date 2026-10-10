#!/usr/bin/env bun

import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { BASELINE_PATHS } from "./baseline-paths";
import {
  analyzeMigrationSqlPerf,
  analyzeSqlPerf,
  isBaselinedSqlPerfKind,
  reportSqlPerfOrColumns,
} from "./sql-perf-detector";
import {
  isSqlPerfMigration,
  isSqlPerfSource,
  SQL_PERF_EXEMPT_MIGRATIONS,
  SQL_PERF_LINT_FILES,
  SQL_PERF_MIGRATION_FILES,
} from "./sql-perf-scope.ts";

export const SQL_PERF_BASELINE_PATH = BASELINE_PATHS.sqlPerf;
const SOURCE_GLOBS = SQL_PERF_LINT_FILES;

export type SqlPerfCounts = Record<string, number>;

export type BaselineIssue = {
  file: string;
  expected: number | null;
  actual: number | null;
  kind: "increase" | "decrease" | "stale" | "absent";
};

export const countSqlPerfHits = (source: string, filename: string): number => {
  const result = analyzeSqlPerf(source, filename);
  if (result.commentErrors.length > 0) {
    const errors = result.commentErrors
      .map(({ line, message }) => `${filename}:${line}: ${message}`)
      .join("\n");
    return panic(errors);
  }
  // OR/subquery, optional-keyset and per-source full-count bans start at zero; per-file
  // allowances cover only the kinds that were present when the baseline was
  // introduced.
  return result.hits.filter((hit) => isBaselinedSqlPerfKind(hit.kind)).length;
};

export const scanSqlPerfCounts = (root: string): SqlPerfCounts => {
  const counts: SqlPerfCounts = {};
  for (const glob of SOURCE_GLOBS) {
    for (const file of new Bun.Glob(glob).scanSync(root)) {
      if (!isSqlPerfSource(file)) {
        continue;
      }
      const source = readFileSync(path.join(root, file), "utf-8");
      const count = countSqlPerfHits(source, file);
      if (count > 0) {
        counts[file] = count;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(counts).toSorted(([left], [right]) =>
      compareCodeUnit(left, right),
    ),
  );
};

/**
 * Findings in the migrations the check reads. None is baselined: each is
 * rewritten or carries a `-- sql-perf-allow` reason. An exemption naming a
 * migration that no longer exists is a finding too.
 */
export const scanSqlPerfMigrations = (root: string): string[] => {
  const findings: string[] = [];
  for (const directory of Object.keys(SQL_PERF_EXEMPT_MIGRATIONS)) {
    if (!existsSync(path.join(root, "apps/api/drizzle", directory))) {
      findings.push(
        `${directory}: exempt from the SQL performance check but not a migration`,
      );
    }
  }
  for (const file of new Bun.Glob(SQL_PERF_MIGRATION_FILES).scanSync(root)) {
    if (!isSqlPerfMigration(file)) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    const { hits, commentErrors } = analyzeMigrationSqlPerf(source);
    for (const { line, column } of hits) {
      findings.push(
        `${file}:${line}:${column}: optional keyset bound (<param> IS NULL OR <column> > <param>)`,
      );
    }
    for (const { line, message } of commentErrors) {
      findings.push(`${file}:${line}: ${message}`);
    }
  }
  return findings.toSorted();
};

export const scanSqlPerfOrColumns = (root: string): string[] => {
  const sites: string[] = [];
  for (const glob of SOURCE_GLOBS) {
    for (const file of new Bun.Glob(glob).scanSync(root)) {
      if (!isSqlPerfSource(file)) {
        continue;
      }
      const source = readFileSync(path.join(root, file), "utf-8");
      for (const { line, column } of reportSqlPerfOrColumns(source, file)) {
        sites.push(`${file}:${line}:${column}`);
      }
    }
  }
  return sites.toSorted();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseSqlPerfCounts = (value: unknown): SqlPerfCounts => {
  if (!isRecord(value)) {
    return panic("SQL performance baseline must be an object");
  }
  const counts: SqlPerfCounts = {};
  for (const [file, count] of Object.entries(value)) {
    if (!isSqlPerfSource(file)) {
      return panic(
        `SQL performance baseline has an out-of-scope path: ${file}`,
      );
    }
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return panic(
        `SQL performance baseline count for ${file} must be a positive integer`,
      );
    }
    counts[file] = count;
  }
  return Object.fromEntries(
    Object.entries(counts).toSorted(([left], [right]) =>
      compareCodeUnit(left, right),
    ),
  );
};

export const compareSqlPerfCounts = (
  current: SqlPerfCounts,
  baseline: SqlPerfCounts,
): BaselineIssue[] => {
  const issues: BaselineIssue[] = [];
  for (const [file, actual] of Object.entries(current)) {
    const expected = baseline[file];
    if (expected === undefined) {
      issues.push({ file, expected: null, actual, kind: "absent" });
    } else if (actual > expected) {
      issues.push({ file, expected, actual, kind: "increase" });
    } else if (actual < expected) {
      issues.push({ file, expected, actual, kind: "decrease" });
    }
  }
  for (const [file, expected] of Object.entries(baseline)) {
    if (current[file] === undefined) {
      issues.push({ file, expected, actual: null, kind: "stale" });
    }
  }
  return issues.toSorted((left, right) =>
    compareCodeUnit(left.file, right.file),
  );
};

export const lowerSqlPerfBaseline = (
  current: SqlPerfCounts,
  baseline: SqlPerfCounts,
): SqlPerfCounts => {
  const increases = compareSqlPerfCounts(current, baseline).filter(
    ({ kind }) => kind === "increase" || kind === "absent",
  );
  if (increases.length > 0) {
    return panic(
      `Refusing to raise SQL performance baseline: ${formatIssues(increases)}`,
    );
  }
  return current;
};

export const assertOriginMainSeedIsClean = (root: string): void => {
  const committedDiff = Bun.spawnSync(
    [
      "git",
      "diff",
      "--quiet",
      "origin/main",
      "HEAD",
      "--",
      "apps/api",
      "packages",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (committedDiff.exitCode !== 0) {
    return panic(
      "Initial SQL performance baseline can only be seeded from origin/main source",
    );
  }
  const status = Bun.spawnSync(
    [
      "git",
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "apps/api",
      "packages",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (status.exitCode !== 0) {
    return panic("Could not verify source changes against origin/main");
  }
  if (status.stdout.toString().trim() !== "") {
    return panic(
      "Initial SQL performance baseline can only be seeded when apps/api and packages are unchanged from origin/main",
    );
  }
};

const parseBaselineText = (text: string): SqlPerfCounts =>
  parseSqlPerfCounts(JSON.parse(text));

const readBaseline = (root: string): SqlPerfCounts => {
  const file = path.join(root, SQL_PERF_BASELINE_PATH);
  if (!existsSync(file)) {
    return panic(`Missing ${SQL_PERF_BASELINE_PATH}`);
  }
  return parseBaselineText(readFileSync(file, "utf-8"));
};

const formatIssues = (issues: readonly BaselineIssue[]): string =>
  issues
    .map(
      ({ file, expected, actual, kind }) =>
        `${file}: ${kind} (${expected ?? "missing"} -> ${actual ?? "none"})`,
    )
    .join("\n");

const readBaseBaseline = (root: string, base: string): SqlPerfCounts | null => {
  const commit = Bun.spawnSync(
    ["git", "rev-parse", "--verify", `${base}^{commit}`],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (commit.exitCode !== 0) {
    return panic(`BASE_SHA does not identify a commit: ${base}`);
  }
  const result = Bun.spawnSync(
    ["git", "show", `${base}:${SQL_PERF_BASELINE_PATH}`],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return parseBaselineText(result.stdout.toString());
};

export const compareAgainstMergeBase = (
  currentBaseline: SqlPerfCounts,
  baseBaseline: SqlPerfCounts | null,
): BaselineIssue[] => {
  if (baseBaseline === null) {
    return [];
  }
  return compareSqlPerfCounts(currentBaseline, baseBaseline).filter(
    ({ kind }) => kind === "increase" || kind === "absent",
  );
};

const writeBaseline = (root: string, counts: SqlPerfCounts): void => {
  writeFileSync(
    path.join(root, SQL_PERF_BASELINE_PATH),
    `${JSON.stringify(counts, null, 2)}\n`,
  );
};

const main = (): number => {
  const root = path.resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  if (args[0] === "--report" && args[1] === "or-columns" && args.length === 2) {
    const sites = scanSqlPerfOrColumns(root);
    for (const site of sites) {
      console.log(site);
    }
    console.log(`OR across columns (report only): ${sites.length} sites.`);
    return 0;
  }
  const mode = args.includes("--write") ? "write" : "check";
  const current = scanSqlPerfCounts(root);
  const baselineExists = existsSync(path.join(root, SQL_PERF_BASELINE_PATH));
  if (!baselineExists && mode !== "write") {
    return panic(`Missing ${SQL_PERF_BASELINE_PATH}`);
  }
  const baseline = baselineExists ? readBaseline(root) : null;
  if (mode === "write" && baseline === null) {
    assertOriginMainSeedIsClean(root);
    writeBaseline(root, current);
    console.log(
      `Seeded SQL performance baseline from unchanged origin/main source at ${SQL_PERF_BASELINE_PATH}`,
    );
    return 0;
  }
  if (baseline === null) {
    return panic("SQL performance baseline was not initialized");
  }
  const issues = compareSqlPerfCounts(current, baseline);
  const migrationFindings = scanSqlPerfMigrations(root);
  if (migrationFindings.length > 0) {
    console.error(
      `SQL performance findings in migrations:\n${migrationFindings.join("\n")}`,
    );
    return 1;
  }

  if (mode === "write") {
    const lowered = lowerSqlPerfBaseline(current, baseline);
    writeBaseline(root, lowered);
    console.log(
      `Wrote lower SQL performance counts to ${SQL_PERF_BASELINE_PATH}`,
    );
    return 0;
  }

  if (issues.length > 0) {
    console.error(
      `SQL performance baseline mismatch:\n${formatIssues(issues)}`,
    );
    return 1;
  }

  const base = process.env["BASE_SHA"];
  if (base) {
    const baseBaseline = readBaseBaseline(root, base);
    const mergeIssues = compareAgainstMergeBase(baseline, baseBaseline);
    if (mergeIssues.length > 0) {
      console.error(
        `SQL performance baseline raises counts from ${base}:\n${formatIssues(mergeIssues)}`,
      );
      return 1;
    }
  }

  console.log("SQL performance baseline: counts match.");
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
