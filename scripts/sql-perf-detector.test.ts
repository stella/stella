import { expect, test } from "bun:test";

import {
  analyzeSqlPerf,
  listSqlPerfAllowComments,
} from "./sql-perf-detector.ts";

/* oxlint-disable eslint/no-template-curly-in-string -- test inputs contain literal template syntax */

const kinds = (source: string) =>
  analyzeSqlPerf(source, "apps/api/src/handlers/example.ts").hits.map(
    (hit) => hit.kind,
  );

test.each([
  ["literal", "sql`name LIKE '%x%'`"],
  ["literal suffix", "sql`name LIKE '%x'`"],
  ["underscore", "sql`name NOT ILIKE '_x'`"],
  ["placeholder", "sql`name LIKE ${`%${term}`}`"],
  ["const binding", "const pattern = `%${term}%`; sql`name ILIKE ${pattern}`"],
  ["SQL concatenation", "sql`name LIKE '%' || ${term}`"],
  ["SQL embedded placeholder", "sql`name LIKE '%${term}'`"],
  ["Drizzle call", "notIlike(name, `%${term}%`)"],
])("finds %s leading wildcard", (_, source) => {
  expect(kinds(source)).toContain("leading-wildcard");
});

test("finds anchored LIKE on an S3-key column", () => {
  expect(
    kinds("sql`${caseLawDecisions.sourceRawS3Key} NOT LIKE ${prefix}`"),
  ).toEqual(["s3-key-like"]);
  expect(kinds("like(caseLawDecisions.sourceRawS3Key, 'pack:%')")).toEqual([
    "s3-key-like",
  ]);
});

test("finds GROUP BY expressions only over corpus relations", () => {
  expect(
    kinds(
      "sql`SELECT count(*) FROM case_law_decisions GROUP BY to_char(decision_date, 'YYYY')`",
    ),
  ).toEqual(["group-by-expression"]);
  expect(
    kinds(
      "sql`SELECT count(*) FROM ${caseLawDecisions} GROUP BY to_char(decision_date, 'YYYY')`",
    ),
  ).toEqual(["group-by-expression"]);
  expect(
    kinds(
      "const year = sql`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`; db.select().from(caseLawDecisions).groupBy(year)",
    ),
  ).toEqual(["group-by-expression"]);
  expect(
    kinds(
      "sql`SELECT to_char(decision_date, 'YYYY') FROM case_law_decisions GROUP BY decision_date`",
    ),
  ).toEqual([]);
  expect(
    kinds(
      "sql`SELECT count(*) FROM case_law_decisions GROUP BY lower('fixed')`",
    ),
  ).toEqual([]);
});

test.each([
  "date_trunc('year', decision_date)",
  "extract(year from decision_date)",
  "substring(ecli from 1 for 4)",
  "split_part(ecli, '.', 1)",
  "coalesce(ecli, '')",
  "lower(ecli)",
  "ecli::text",
  "metadata->>'year'",
])("finds corpus GROUP BY %s", (expression) => {
  expect(
    kinds(
      `sql\`SELECT count(*) FROM case_law_decisions GROUP BY ${expression}\``,
    ),
  ).toContain("group-by-expression");
});

test.each([
  "sql`name LIKE 'prefix%'`",
  "sql`CHECK (name LIKE '%x%')`",
  "const text = \"name LIKE '%x%'\"",
])("accepts non-target shape: %s", (source) => {
  expect(kinds(source)).toEqual([]);
});

test.each([
  "small table clauses, capped 500 per org",
  "index legislation_documents_eli_trgm_idx",
  "bounded by keyset page on source_id LIMIT 500",
])("accepts nearby reason: %s", (reason) => {
  const result = analyzeSqlPerf(
    `// sql-perf-allow: ${reason}\nconst hit = sql\`name LIKE '%x%'\`;`,
    "apps/api/src/handlers/example.ts",
  );
  expect(result).toEqual({ hits: [], commentErrors: [] });
});

test("accepts a reason on the flagged line", () => {
  expect(
    analyzeSqlPerf(
      "const hit = sql`name LIKE '%x%'`; // sql-perf-allow: index name_trgm_idx",
      "apps/api/src/handlers/example.ts",
    ),
  ).toEqual({ hits: [], commentErrors: [] });
});

test.each([
  ["missing", "// sql-perf-allow:\nconst hit = sql`name LIKE '%x%'`;"],
  [
    "invalid",
    "// sql-perf-allow: it is fine\nconst hit = sql`name LIKE '%x%'`;",
  ],
  [
    "unused",
    "// sql-perf-allow: index some_idx\nconst hit = sql`name LIKE 'x%'`;",
  ],
])("rejects %s comment", (_, source) => {
  const result = analyzeSqlPerf(source, "apps/api/src/handlers/example.ts");
  expect(result.commentErrors).toHaveLength(1);
});

test("standard CAST in a corpus GROUP BY is an expression", () => {
  expect(
    kinds(
      "sql`SELECT count(*) FROM case_law_decisions GROUP BY CAST(ecli AS text)`",
    ),
  ).toEqual(["group-by-expression"]);
});

test("a const resolves in its own scope, not by name across the file", () => {
  const source = [
    "const first = () => {",
    "  const pattern = `%${term}%`;",
    "  return sql`name ILIKE ${pattern}`;",
    "};",
    "const second = () => {",
    "  const pattern = `${term}%`;",
    "  return sql`name ILIKE ${pattern}`;",
    "};",
  ].join("\n");
  const { hits } = analyzeSqlPerf(source, "apps/api/src/example.ts");
  expect(hits.map(({ kind, line }) => ({ kind, line }))).toEqual([
    { kind: "leading-wildcard", line: 3 },
  ]);
});

test("a reason above a multi-line SQL template covers the hit inside it", () => {
  // The flagged line is SQL text, where no TypeScript comment can go.
  const aboveStatement = [
    "// sql-perf-allow: index name_trgm_idx",
    "const rows = await tx.execute(sql`",
    "  SELECT id",
    "  FROM contacts",
    "  WHERE name ILIKE '%x%'",
    "`);",
  ].join("\n");
  const aboveTemplate = [
    "const rows = await tx.execute(",
    "  // sql-perf-allow: bounded by one workspace, LIMIT 50",
    "  sql`",
    "    SELECT id FROM contacts",
    "    WHERE name ILIKE '%x%'",
    "  `,",
    ");",
  ].join("\n");
  for (const source of [aboveStatement, aboveTemplate]) {
    expect(analyzeSqlPerf(source, "apps/api/src/example.ts")).toEqual({
      hits: [],
      commentErrors: [],
    });
  }
});

test("a reason two lines above the statement does not reach it", () => {
  const source = [
    "// sql-perf-allow: index name_trgm_idx",
    "",
    "const rows = await tx.execute(sql`",
    "  WHERE name ILIKE '%x%'",
    "`);",
  ].join("\n");
  const { hits, commentErrors } = analyzeSqlPerf(
    source,
    "apps/api/src/example.ts",
  );
  expect(hits.map((hit) => hit.kind)).toEqual(["leading-wildcard"]);
  expect(commentErrors.map((error) => error.line)).toEqual([1]);
});

test("a marker in a string cannot suppress a hit", () => {
  const result = analyzeSqlPerf(
    "const note = '// sql-perf-allow: index fake_idx';\nconst hit = sql`name LIKE '%x%'`;",
    "apps/api/src/handlers/example.ts",
  );
  expect(result.hits).toHaveLength(1);
  expect(result.commentErrors).toHaveLength(0);
});

test("comment inventory recognizes same-line comments and ignores string contents", () => {
  expect(
    listSqlPerfAllowComments(
      "const note = '// sql-perf-allow: index fake_idx';\nconst hit = sql`name LIKE '%x%'`; // sql-perf-allow: index name_trgm_idx",
      "apps/api/src/handlers/example.ts",
    ),
  ).toEqual([{ line: 2, reason: "index name_trgm_idx" }]);
});
