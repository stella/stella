import { describe, expect, test } from "bun:test";

import {
  compareAgainstMergeBase,
  compareSqlPerfCounts,
  countSqlPerfHits,
  lowerSqlPerfBaseline,
  parseSqlPerfCounts,
} from "./sql-perf-baseline";
import {
  isSqlPerfSource,
  SQL_PERF_LINT_EXCLUDES,
  SQL_PERF_LINT_FILES,
} from "./sql-perf-scope";

describe("SQL performance baseline source scope", () => {
  test.each([
    ["apps/api/src/handlers/query.ts", true],
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
