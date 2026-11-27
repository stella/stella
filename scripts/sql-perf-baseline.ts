#!/usr/bin/env bun

import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import {
  analyzeMigrationSqlPerf,
  analyzeSqlPerf,
  reportSqlPerfOrColumns,
} from "./sql-perf-detector";
import {
  isSqlPerfMigration,
  isSqlPerfSource,
  SQL_PERF_EXEMPT_MIGRATIONS,
  SQL_PERF_LINT_FILES,
  SQL_PERF_MIGRATION_FILES,
} from "./sql-perf-scope.ts";

const SOURCE_GLOBS = SQL_PERF_LINT_FILES;

export type SqlPerfCounts = Record<string, number>;

export const countSqlPerfHits = (source: string, filename: string): number => {
  const result = analyzeSqlPerf(source, filename);
  if (result.commentErrors.length > 0) {
    const errors = result.commentErrors
      .map(({ line, message }) => `${filename}:${line}: ${message}`)
      .join("\n");
    return panic(errors);
  }
  return result.hits.length;
};

export const scanSqlPerfCounts = (root: string): SqlPerfCounts => {
  const counts = new Map<string, number>();
  for (const glob of SOURCE_GLOBS) {
    for (const file of new Bun.Glob(glob).scanSync(root)) {
      if (!isSqlPerfSource(file)) {
        continue;
      }
      const source = readFileSync(path.join(root, file), "utf-8");
      const count = countSqlPerfHits(source, file);
      if (count > 0) {
        counts.set(file, count);
      }
    }
  }
  return Object.fromEntries(
    [...counts].toSorted(([left], [right]) => compareCodeUnit(left, right)),
  );
};

/**
 * Findings in the migrations the check reads. Each must be rewritten or carry
 * a `-- sql-perf-allow` reason. An exemption naming a migration that no longer
 * exists is a finding too.
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
  const migrationFindings = scanSqlPerfMigrations(root);
  if (migrationFindings.length > 0) {
    console.error(
      `SQL performance findings in migrations:\n${migrationFindings.join("\n")}`,
    );
    return 1;
  }
  const current = scanSqlPerfCounts(root);
  const entries = Object.entries(current);
  if (entries.length > 0) {
    const lines = entries.map(([file, count]) => `${file}: ${String(count)}`);
    console.error(`SQL performance findings:\n${lines.join("\n")}`);
    return 1;
  }
  console.log("SQL performance check: 0 findings.");
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
