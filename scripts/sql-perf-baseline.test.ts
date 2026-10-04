import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compareAgainstMergeBase,
  compareSqlPerfCounts,
  countSqlPerfHits,
  lowerSqlPerfBaseline,
  parseSqlPerfCounts,
  scanSqlPerfMigrations,
} from "./sql-perf-baseline";
import {
  isSqlPerfSource,
  SQL_PERF_LINT_EXCLUDES,
  SQL_PERF_LINT_FILES,
} from "./sql-perf-scope";

describe("SQL performance baseline source scope", () => {
  test.each([
    ["apps/api/src/handlers/query.ts", true],
    ["apps/api/scripts/query.ts", true],
    ["apps/legal-atlas-runner/src/runners/query.ts", true],
    ["apps/legal-atlas-runner/src/runners/query.test.ts", false],
    ["apps/api/scripts/__fixtures__/query.ts", false],
    ["packages/legal/src/query.tsx", true],
    ["apps/web/src/query.ts", false],
    ["packages/legal/src/query.test.ts", false],
    ["apps/api/src/handlers/__tests__/query.ts", false],
    ["apps/api/src/db/schema/query.ts", false],
    ["apps/api/drizzle/20260901_migration.ts", false],
    ["packages/legal/src/fixtures/query.ts", false],
    ["packages/legal/src/__fixtures__/query.ts", false],
    ["apps/api/src/tests/helpers/query.ts", false],
    ["scripts/query.ts", false],
  ])("%s is in scope: %s", (file, expected) => {
    expect(isSqlPerfSource(file)).toBe(expected);
  });

  test("the baseline scope is the lint override's scope", () => {
    const inLint = (file: string) =>
      SQL_PERF_LINT_FILES.some((glob) => new Bun.Glob(glob).match(file)) &&
      !SQL_PERF_LINT_EXCLUDES.some((glob) => new Bun.Glob(glob).match(file));
    for (const file of [
      "apps/api/src/handlers/query.ts",
      "apps/api/scripts/query.ts",
      "apps/legal-atlas-runner/src/runners/query.ts",
      "apps/legal-atlas-runner/src/runners/query.test.ts",
      "apps/api/scripts/__fixtures__/query.ts",
      "apps/api/src/lib/search/index-global.ts",
      "packages/legal/src/query.tsx",
      "packages/legal/src/query.test.ts",
      "packages/legal/src/query.spec.tsx",
      "apps/api/src/handlers/__tests__/query.ts",
      "apps/api/src/tests/helpers/query.ts",
      "packages/legal/src/__fixtures__/query.ts",
      "packages/legal/src/fixtures/query.ts",
      "apps/api/src/db/schema/case-law.ts",
      "packages/db/drizzle/query.ts",
      "apps/web/src/query.ts",
    ]) {
      expect(isSqlPerfSource(file), file).toBe(inLint(file));
    }
  });

  test("counts detector hits and refuses malformed or unused suppressions", () => {
    const source = `const pattern = \`%\${term}%\`;
sql\`SELECT id FROM case_law_decisions WHERE title ILIKE \${pattern}\`;
`;
    expect(countSqlPerfHits(source, "apps/api/src/search.ts")).toBe(1);
    expect(
      countSqlPerfHits(
        'import { or, notExists } from "drizzle-orm"; or(eq(a, b), notExists(db.select().from(other)));',
        "apps/api/src/search.ts",
      ),
    ).toBe(0);
    expect(() =>
      countSqlPerfHits(
        "// sql-perf-allow: because\nconst value = 1;",
        "apps/api/src/search.ts",
      ),
    ).toThrow(/sql-perf-allow/u);
  });
});

describe("SQL performance baseline reconciliation", () => {
  test("requires exact per-file counts, including stale and unbudgeted files", () => {
    expect(
      compareSqlPerfCounts(
        { "apps/api/a.ts": 1, "apps/api/new.ts": 2 },
        { "apps/api/a.ts": 2, "apps/api/gone.ts": 1 },
      ),
    ).toEqual([
      { file: "apps/api/a.ts", expected: 2, actual: 1, kind: "decrease" },
      { file: "apps/api/gone.ts", expected: 1, actual: null, kind: "stale" },
      { file: "apps/api/new.ts", expected: null, actual: 2, kind: "absent" },
    ]);
  });

  test("write permits only decreases and removal", () => {
    expect(
      lowerSqlPerfBaseline(
        { "apps/api/a.ts": 1 },
        { "apps/api/a.ts": 2, "apps/api/removed.ts": 1 },
      ),
    ).toEqual({ "apps/api/a.ts": 1 });
    expect(() =>
      lowerSqlPerfBaseline({ "apps/api/a.ts": 3 }, { "apps/api/a.ts": 2 }),
    ).toThrow(/Refusing to raise/u);
    expect(() => lowerSqlPerfBaseline({ "apps/api/new.ts": 1 }, {})).toThrow(
      /absent/u,
    );
  });

  test("merge-base comparison rejects raised counts but permits decreases", () => {
    expect(
      compareAgainstMergeBase(
        { "apps/api/a.ts": 1, "apps/api/new.ts": 1 },
        { "apps/api/a.ts": 2 },
      ),
    ).toEqual([
      { file: "apps/api/new.ts", expected: null, actual: 1, kind: "absent" },
    ]);
    expect(compareAgainstMergeBase({ "apps/api/a.ts": 1 }, null)).toEqual([]);
  });

  test("rejects invalid baseline paths and counts", () => {
    expect(() => parseSqlPerfCounts({ "apps/web/a.ts": 1 })).toThrow(
      /out-of-scope/u,
    );
    expect(() => parseSqlPerfCounts({ "apps/api/src/a.ts": 0 })).toThrow(
      /positive integer/u,
    );
    expect(
      parseSqlPerfCounts({ "apps/api/src/b.ts": 1, "apps/api/src/a.ts": 2 }),
    ).toEqual({
      "apps/api/src/a.ts": 2,
      "apps/api/src/b.ts": 1,
    });
  });
});

describe("SQL performance migration scan", () => {
  const PAGE_WITH_OPTIONAL_CURSOR = [
    "CREATE FUNCTION page() RETURNS void LANGUAGE plpgsql AS $$",
    "BEGIN",
    "  SELECT id INTO next_id FROM decisions",
    "  WHERE (after_id IS NULL OR id > after_id) ORDER BY id LIMIT 50;",
    "END;",
    "$$;",
  ].join("\n");

  const withMigrations = (
    migrations: Record<string, string>,
    check: (root: string) => void,
  ) => {
    const root = mkdtempSync(path.join(tmpdir(), "sql-perf-migrations-"));
    try {
      for (const [directory, source] of Object.entries(migrations)) {
        const folder = path.join(root, "apps/api/drizzle", directory);
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, "migration.sql"), source);
      }
      check(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("flags a migration dated before existing ones and skips the exempt one", () => {
    withMigrations(
      {
        "20200101000000_rebased_page": PAGE_WITH_OPTIONAL_CURSOR,
        "20260926170000_case_law_provision_backfill": PAGE_WITH_OPTIONAL_CURSOR,
      },
      (root) => {
        expect(scanSqlPerfMigrations(root)).toEqual([
          "apps/api/drizzle/20200101000000_rebased_page/migration.sql:4:10: optional keyset bound (<param> IS NULL OR <column> > <param>)",
        ]);
      },
    );
  });

  test("an exemption for a missing migration is a finding", () => {
    withMigrations({ "20200101000000_clean": "SELECT 1;" }, (root) => {
      expect(scanSqlPerfMigrations(root)).toEqual([
        "20260926170000_case_law_provision_backfill: exempt from the SQL performance check but not a migration",
      ]);
    });
  });

  test("the repository's migrations have no finding", () => {
    expect(scanSqlPerfMigrations(path.resolve(import.meta.dir, ".."))).toEqual(
      [],
    );
  });
});
