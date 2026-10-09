import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

/**
 * These suites change committed tables in the common PostgreSQL test database.
 * They run after every ordinary suite, each in its own test process, so no CRUD
 * transaction can retain a conflicting table lock while their DDL runs.
 */
export const EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS: ReadonlySet<string> =
  new Set([
    "src/handlers/case-law/ingestion/background-replay-store.postgres.test.ts",
    "src/handlers/case-law/ingestion/reconciliation-listing-revisions.postgres.test.ts",
    "src/lib/hosted-usage-provider/replay.postgres.test.ts",
    "src/lib/lists/sanctions/monitoring-concurrency.postgres.test.ts",
    "src/lib/lists/sanctions/monitoring-migrations.postgres.test.ts",
    "src/lib/lists/sanctions/monitoring-roles.postgres.test.ts",
    "src/lib/scheduler/tasks/registration-retention.postgres.test.ts",
  ]);

export const isolateSharedTableDdlTests = (
  testPaths: readonly string[],
  isolatedPaths = EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
): string[][] => {
  const shared = testPaths.filter((testPath) => !isolatedPaths.has(testPath));
  const isolated = testPaths
    .filter((testPath) => isolatedPaths.has(testPath))
    .map((testPath) => [testPath]);
  return shared.length > 0 ? [shared, ...isolated] : isolated;
};

const TABLE_HEADING = /^## ([a-z][a-z0-9_]*) ·/gmu;
const TABLE_DDL =
  /\b(?:ALTER|DROP|TRUNCATE)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/giu;
const TRIGGER_DDL =
  /\b(?:CREATE|DROP)\s+TRIGGER\b[^;]*?\bON\s+(?:(?:"public"|public)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/giu;
const INDEX_DDL =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:(?:"public"|public)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/giu;

export const readSharedTableNames = (apiRoot: string): ReadonlySet<string> => {
  const names = new Set<string>();
  const indexRoot = path.join(apiRoot, "src/db/schema-index");
  for (const indexPath of new Bun.Glob("*.md").scanSync({
    cwd: indexRoot,
    onlyFiles: true,
  })) {
    const source = readFileSync(path.join(indexRoot, indexPath), "utf-8");
    for (const match of source.matchAll(TABLE_HEADING)) {
      const name = match.at(1);
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return names;
};

export const sharedTableDdlTargets = (
  source: string,
  sharedTables: ReadonlySet<string>,
): string[] => {
  const targets = new Set<string>();
  for (const pattern of [TABLE_DDL, TRIGGER_DDL, INDEX_DDL]) {
    for (const match of source.matchAll(pattern)) {
      const table = match.at(1)?.toLowerCase();
      if (table !== undefined && sharedTables.has(table)) {
        targets.add(table);
      }
    }
  }
  return [...targets].toSorted();
};

type SharedTableDdlViolation = {
  testPath: string;
  tables: string[];
};

type FindSharedTableDdlViolationsOptions = {
  sources: ReadonlyMap<string, string>;
  sharedTables: ReadonlySet<string>;
  isolatedPaths?: ReadonlySet<string>;
};

/** Enumerate every PostgreSQL suite whose shared-table DDL lacks isolation. */
export const findSharedTableDdlViolations = ({
  sources,
  sharedTables,
  isolatedPaths = EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
}: FindSharedTableDdlViolationsOptions): SharedTableDdlViolation[] =>
  [...sources]
    .filter(([testPath]) => /\.postgres\.test\.tsx?$/u.test(testPath))
    .flatMap(([testPath, source]) => {
      const tables = sharedTableDdlTargets(source, sharedTables);
      return tables.length > 0 && !isolatedPaths.has(testPath)
        ? [{ testPath, tables }]
        : [];
    })
    .toSorted((left, right) => compareCodeUnit(left.testPath, right.testPath));

export const assertSharedTableDdlIsolated = async (
  apiRoot: string,
  testPaths: readonly string[],
): Promise<void> => {
  const sources = new Map(
    await Promise.all(
      testPaths.map(
        async (testPath) =>
          [
            testPath,
            await Bun.file(path.join(apiRoot, testPath)).text(),
          ] as const,
      ),
    ),
  );
  const violations = findSharedTableDdlViolations({
    sources,
    sharedTables: readSharedTableNames(apiRoot),
  });
  if (violations.length === 0) {
    return;
  }
  panic(
    `PostgreSQL tests that run DDL on shared tables require an exclusive test process:\n${violations
      .map(({ testPath, tables }) => `  ${testPath}: ${tables.join(", ")}`)
      .join("\n")}\nAdd each path to EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS.`,
  );
};
