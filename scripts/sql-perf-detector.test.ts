import { expect, test } from "bun:test";

import {
  analyzeSqlPerf,
  isBaselinedSqlPerfKind,
  listSqlPerfAllowComments,
  reportSqlPerfOrColumns,
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

test("flags the decision identity OR/subquery shape", () => {
  const source = [
    'import { and, eq, inArray, or } from "drizzle-orm";',
    "const predicate = or(",
    "  inArray(caseLawDecisions.ecli, [value, upperValue]),",
    "  inArray(caseLawDecisions.id, tx.select({ id: identifiers.decisionId }).from(identifiers).where(and(eq(identifiers.type, kind), eq(identifiers.normalizedValue, value)))),",
    ");",
  ].join("\n");
  expect(kinds(source)).toEqual(["or-subquery"]);
});

test("flags Drizzle negative membership with a select operand", () => {
  const source = [
    'import { eq, notInArray, or } from "drizzle-orm";',
    "or(eq(caseLawDecisions.ecli, value), notInArray(caseLawDecisions.id, tx.select({ id: identifiers.decisionId }).from(identifiers)));",
  ].join("\n");
  expect(kinds(source)).toEqual(["or-subquery"]);
});

test("flags aliased Drizzle imports but not unrelated functions with the same names", () => {
  expect(
    kinds(
      'import { or as anyOf, inArray as among } from "drizzle-orm"; anyOf(eq(a, b), among(table.id, db.select().from(other)));',
    ),
  ).toEqual(["or-subquery"]);
  expect(
    kinds(
      'import * as d from "drizzle-orm"; d.or(d.eq(a, b), d.notExists(db.select().from(other)));',
    ),
  ).toEqual(["or-subquery"]);
  expect(
    kinds(
      'import { or as anyOf, exists as isPresent } from "drizzle-orm"; anyOf(eq(a, b), isPresent(db.select().from(other)));',
    ),
  ).toEqual(["or-subquery"]);
  expect(kinds("or(eq(a, b), exists(db.select().from(other)))")).toEqual([]);
  expect(
    kinds(
      'import type { or, exists } from "drizzle-orm"; or(eq(a, b), exists(db.select().from(other)));',
    ),
  ).toEqual([]);
});

test("accepts the UNION ALL identity lookup and scalar OR predicates", () => {
  expect(
    kinds(
      [
        'import { and, eq, inArray, or } from "drizzle-orm";',
        'import { unionAll } from "drizzle-orm/pg-core";',
        "inArray(caseLawDecisions.id, unionAll(tx.select({ id: caseLawDecisions.id }).from(caseLawDecisions), tx.select({ id: identifiers.decisionId }).from(identifiers)));",
        "or(eq(caseLawDecisions.ecli, value), eq(caseLawDecisions.ecli, upperValue));",
        "or(gt(caseLawDecisions.decisionDate, date), and(eq(caseLawDecisions.decisionDate, date), gt(caseLawDecisions.id, id)));",
        "or(eq(a.status, ready), eq(a.status, pending));",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test.each([
  "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR id IN (SELECT decision_id FROM case_law_decision_identifiers)`",
  "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR EXISTS (SELECT 1 FROM case_law_decision_identifiers)`",
  "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR NOT EXISTS (SELECT 1 FROM case_law_decision_identifiers)`",
  "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR id NOT IN (SELECT decision_id FROM case_law_decision_identifiers)`",
  "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR ${caseLawDecisions.id} IN (${tx.select({ id: identifiers.decisionId }).from(identifiers)})`",
  "const sub = sql`SELECT decision_id FROM case_law_decision_identifiers`; sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR ${caseLawDecisions.id} IN (${sub})`",
  "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR id = ANY (SELECT decision_id FROM case_law_decision_identifiers)`",
  "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR (id, country) IN (SELECT decision_id, country FROM case_law_decision_identifiers)`",
])("flags SQL-text OR/subquery: %s", (source) => {
  expect(kinds(source)).toEqual(["or-subquery"]);
});

test.each([
  "sql`SELECT id FROM case_law_decisions WHERE EXISTS (SELECT 1 FROM case_law_decision_identifiers) OR status = ${status}`",
  "sql`SELECT id FROM case_law_decisions WHERE id IN (SELECT decision_id FROM case_law_decision_identifiers) OR status = ${status}`",
  "sql`SELECT id FROM case_law_decisions WHERE id NOT IN (SELECT decision_id FROM case_law_decision_identifiers) OR status = ${status}`",
])("flags SQL-text subqueries left of OR: %s", (source) => {
  expect(kinds(source)).toEqual(["or-subquery"]);
});

test.each([
  'import { eq, or, sql } from "drizzle-orm"; or(eq(table.id, id), sql`EXISTS (SELECT 1 FROM other)`);',
  'import { eq, or, sql } from "drizzle-orm"; or(eq(table.id, id), sql`id IN (SELECT id FROM other)`);',
  'import { eq, or, sql } from "drizzle-orm"; or(eq(table.id, id), sql`SELECT id FROM other`);',
])("flags raw SQL subquery operands of Drizzle or(): %s", (source) => {
  expect(kinds(source)).toEqual(["or-subquery"]);
});

test("does not treat an interpolated value list as a subquery", () => {
  expect(
    kinds(
      "sql`SELECT id FROM case_law_decisions WHERE ecli = ${ecli} OR ${caseLawDecisions.id} IN (${ids})`",
    ),
  ).toEqual([]);
});

test("does not treat a SQL string inside a raw operand as a subquery", () => {
  expect(
    kinds(
      "import { eq, or, sql } from \"drizzle-orm\"; or(eq(table.id, id), sql`note = 'SELECT EXISTS ('`);",
    ),
  ).toEqual([]);
});

test("does not read OR/subquery syntax inside a SQL string or comment", () => {
  expect(
    kinds(
      "sql`SELECT 'OR EXISTS (SELECT 1)' AS note -- OR id IN (SELECT 1)\nFROM case_law_decisions`",
    ),
  ).toEqual([]);
});

test("an allowed bounded OR/subquery does not consume the old baseline", () => {
  const source = [
    'import { or, notExists } from "drizzle-orm";',
    "// sql-perf-allow: bounded by one indexed row",
    "const predicate = or(eq(user.id, id), notExists(tx.select().from(member)));",
  ].join("\n");
  expect(analyzeSqlPerf(source, "apps/api/src/handlers/example.ts")).toEqual({
    hits: [],
    commentErrors: [],
  });
});

test("reports corpus cross-column ORs while excluding keysets and tenant tables", () => {
  const source = [
    'import { and, eq, gt, or } from "drizzle-orm";',
    "or(eq(caseLawDecisions.country, country), eq(caseLawDecisions.court, court));",
    "or(eq(caseLawDecisions.country, country), eq(caseLawDecisions.country, otherCountry));",
    "or(gt(caseLawDecisions.decisionDate, date), and(eq(caseLawDecisions.decisionDate, date), gt(caseLawDecisions.id, id)));",
    "and(eq(entities.workspaceId, workspaceId), or(eq(entities.status, active), eq(entities.type, kind)));",
    "or(eq(legislationDocuments.country, country), eq(legislationDocuments.language, language));",
  ].join("\n");
  expect(
    reportSqlPerfOrColumns(source, "apps/api/src/handlers/example.ts").map(
      (hit) => hit.line,
    ),
  ).toEqual([2, 6]);
});

test("reports SQL-text cross-column OR but leaves a keyset continuation alone", () => {
  const source = [
    "sql`SELECT id FROM case_law_decisions WHERE case_law_decisions.country = ${country} OR case_law_decisions.court = ${court}`;",
    "sql`SELECT id FROM case_law_decisions WHERE (case_law_decisions.decision_date > ${date}) OR (case_law_decisions.decision_date = ${date} AND case_law_decisions.id > ${id})`;",
  ].join("\n");
  expect(
    reportSqlPerfOrColumns(source, "apps/api/src/handlers/example.ts").map(
      (hit) => hit.line,
    ),
  ).toEqual([1]);
});

test.each([
  [
    "a plain string",
    "connection.query(`SELECT id FROM case_law_decisions WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`, [cursor, size]);",
  ],
  [
    "a quoted string",
    "connection.query('SELECT id FROM decisions WHERE $1 IS NULL OR id >= $1 ORDER BY id LIMIT 50', [cursor]);",
  ],
  [
    "a sql template",
    "sql`SELECT e.id FROM entities e WHERE (${state.cursor}::uuid IS NULL OR e.id > ${state.cursor}::uuid) ORDER BY e.id LIMIT ${size}`",
  ],
  [
    "the reverse order across lines",
    "sql`SELECT id FROM jobs\n  WHERE (created_at < ${before}::timestamptz\n     OR ${before}::timestamptz IS NULL)\n  ORDER BY created_at DESC LIMIT 20`",
  ],
])("flags an optional keyset bound in %s", (_, source) => {
  expect(kinds(source)).toEqual(["optional-keyset"]);
});

test.each([
  [
    "separate first and later pages",
    "connection.query(`SELECT id FROM case_law_decisions WHERE id > $1::uuid ORDER BY id LIMIT 50`, [cursor]);",
  ],
  [
    "a nullable column rather than a parameter",
    "sql`SELECT id FROM versions WHERE valid_from IS NULL OR valid_from <= ${asOf} ORDER BY id LIMIT 10`",
  ],
  [
    "a different parameter in the range",
    "sql`SELECT id FROM decisions WHERE ${from}::date IS NULL OR decision_date >= ${to}::date ORDER BY id LIMIT 10`",
  ],
  [
    "an unpaged optional filter",
    "sql`UPDATE citations SET status = 'pending' WHERE ${date}::date IS NULL OR decision_date >= ${date}::date`",
  ],
  [
    "a placeholder interpolated into a plain string",
    "const text = `SELECT id FROM t WHERE ${cursor} IS NULL OR id > ${cursor} LIMIT 5`;",
  ],
  [
    "the shape inside a SQL string",
    "sql`SELECT 'x IS NULL OR id > x' AS note FROM t WHERE id > ${cursor} LIMIT 5`",
  ],
])("accepts %s", (_, source) => {
  expect(kinds(source)).toEqual([]);
});

test("an optional keyset bound takes a reason and is never baselined", () => {
  const source = [
    "// sql-perf-allow: small table sessions",
    "const page = sql`SELECT id FROM sessions WHERE ${cursor}::uuid IS NULL OR id > ${cursor}::uuid LIMIT 10`;",
  ].join("\n");
  expect(analyzeSqlPerf(source, "apps/api/src/handlers/example.ts")).toEqual({
    hits: [],
    commentErrors: [],
  });
  expect(isBaselinedSqlPerfKind("optional-keyset")).toBe(false);
  expect(isBaselinedSqlPerfKind("leading-wildcard")).toBe(true);
});
