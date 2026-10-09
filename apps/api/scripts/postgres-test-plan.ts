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
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/giu;
// DROP TABLE, TRUNCATE and LOCK (TABLE optional) take comma-separated target
// lists. The list accepts table names only, so it ends at the first other token
// and an adjacent statement without a semicolon still gets its own match.
const LIST_TABLE_NAME = String.raw`(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?"?(?!(?:alter|create|drop|lock|truncate)\b)[a-z][a-z0-9_]*"?(?:\s*\*)?`;
const TABLE_LIST_DDL = new RegExp(
  String.raw`\b(?:DROP\s+TABLE(?:\s+IF\s+EXISTS)?|TRUNCATE(?:\s+TABLE)?|LOCK(?:\s+TABLE)?)\s+(${LIST_TABLE_NAME}(?:\s*,\s*${LIST_TABLE_NAME})*)`,
  "giu",
);
const LIST_ITEM_TABLE =
  /^(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/iu;

const tableListTargets = (list: string): string[] =>
  list.split(",").flatMap((item) => {
    const table = LIST_ITEM_TABLE.exec(item.trim())?.at(1)?.toLowerCase();
    return table === undefined ? [] : [table];
  });

// Every statement that names its table after ON: triggers, indexes, rule drops
// and row-level security policies, in each PostgreSQL spelling.
const ON_TABLE_DDL =
  /\b(?:(?:CREATE(?:\s+OR\s+REPLACE)?(?:\s+CONSTRAINT)?|ALTER|DROP)\s+TRIGGER|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+RULE|(?:CREATE|ALTER|DROP)\s+POLICY)\b[^;]*?\bON\s+(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/giu;
// CREATE RULE names its event after ON and its table after TO.
const RULE_DDL =
  /\bCREATE(?:\s+OR\s+REPLACE)?\s+RULE\b[^;]*?\bTO\s+(?:(?:"public"|public)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/giu;

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
  for (const pattern of [TABLE_DDL, ON_TABLE_DDL, RULE_DDL]) {
    for (const match of source.matchAll(pattern)) {
      const table = match.at(1)?.toLowerCase();
      if (table !== undefined && sharedTables.has(table)) {
        targets.add(table);
      }
    }
  }
  for (const match of source.matchAll(TABLE_LIST_DDL)) {
    for (const table of tableListTargets(match.at(1) ?? "")) {
      if (sharedTables.has(table)) {
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
