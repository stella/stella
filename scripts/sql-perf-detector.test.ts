import { expect, test } from "bun:test";

import { HIGH_VOLUME_TABLES } from "../apps/api/src/db/high-volume-tables.ts";
import {
  analyzeMigrationSqlPerf,
  analyzeSqlPerf,
  isBaselinedSqlPerfKind,
  listSqlPerfAllowComments,
  reportSqlPerfOrColumns,
} from "./sql-perf-detector.ts";
import { isSqlPerfMigration } from "./sql-perf-scope.ts";

/* oxlint-disable no-template-curly-in-string -- test inputs contain literal template syntax */

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
  [
    "each operand parenthesized",
    "connection.query(`SELECT id FROM case_law_decisions WHERE (($1::uuid IS NULL) OR (id > $1::uuid)) ORDER BY id LIMIT 50`, [cursor]);",
  ],
  [
    "each operand parenthesized, in the reverse order",
    "sql`SELECT id FROM jobs WHERE ( ( id > ${cursor}::uuid ) OR ( ${cursor}::uuid IS NULL ) ) ORDER BY id LIMIT 20`",
  ],
  [
    "operands in doubled parentheses",
    "connection.query('SELECT id FROM t WHERE (($1 IS NULL)) OR ((id > $1)) LIMIT 10', [cursor]);",
  ],
  [
    "a schema-qualified cast",
    "connection.query('SELECT id FROM t WHERE $1::pg_catalog.uuid IS NULL OR id > $1::pg_catalog.uuid LIMIT 10', [cursor]);",
  ],
  [
    "a schema-qualified cast, in the reverse order",
    "connection.query('SELECT id FROM t WHERE id > $1::pg_catalog.uuid OR $1::pg_catalog.uuid IS NULL LIMIT 10', [cursor]);",
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

const migrationHitLines = (source: string) =>
  analyzeMigrationSqlPerf(source).hits.map(({ line }) => line);

const ROUTINE_PAGE = (predicate: string) =>
  [
    "CREATE FUNCTION page(job_country varchar) RETURNS void LANGUAGE plpgsql AS $$",
    "BEGIN",
    "  SELECT array_agg(id) INTO page_ids FROM (",
    '    SELECT "id" FROM "decisions"',
    `    WHERE "country" = job_country AND ${predicate}`,
    '    ORDER BY "id" LIMIT 50',
    "  ) page;",
    "END;",
    "$$;--> statement-breakpoint",
  ].join("\n");

test.each([
  ["a record field", '(job."cursor_id" IS NULL OR "id" > job."cursor_id")'],
  ["a variable", "(after_id IS NULL OR id >= after_id)"],
  ["a parameter", "($1::uuid IS NULL OR id > $1::uuid)"],
  ["the reverse order", "(id > after_id OR after_id IS NULL)"],
])("flags an optional keyset bound on %s in a routine body", (_, predicate) => {
  expect(migrationHitLines(ROUTINE_PAGE(predicate))).toEqual([5]);
});

test.each([
  ["a required bound", '"id" > job."cursor_id"'],
  ["a different variable in the range", "(after_id IS NULL OR id > before_id)"],
  ["a bound in a comment", "true -- (after_id IS NULL OR id > after_id)"],
])("accepts %s in a routine body", (_, predicate) => {
  expect(migrationHitLines(ROUTINE_PAGE(predicate))).toEqual([]);
});

test.each([
  ["an unquoted name in another case", "(after_id IS NULL OR id > AFTER_ID)"],
  [
    "an unquoted record and field in another case",
    "(job.cursor_id IS NULL OR id > JOB.Cursor_Id)",
  ],
  [
    "a quoted field and its unquoted lower-case name",
    '(job."cursor_id" IS NULL OR id > job.cursor_id)',
  ],
])("names one cursor through %s", (_, predicate) => {
  expect(migrationHitLines(ROUTINE_PAGE(predicate))).toEqual([5]);
});

test.each([
  [
    "quoted names that differ in case",
    '(job."Cursor" IS NULL OR id > job."cursor")',
  ],
  [
    "a quoted mixed-case name and its unquoted spelling",
    '(job."Cursor" IS NULL OR id > job.cursor)',
  ],
])("tells apart %s", (_, predicate) => {
  expect(migrationHitLines(ROUTINE_PAGE(predicate))).toEqual([]);
});

test("an apostrophe in a migration comment hides no statement", () => {
  expect(
    migrationHitLines(
      `-- The function's page read.\n${ROUTINE_PAGE("(after_id IS NULL OR id > after_id)")}\nSELECT 'x';`,
    ),
  ).toEqual([6]);
});

test("accepts optional bounds outside a paged statement", () => {
  const source = [
    'ALTER TABLE "runs" ADD CONSTRAINT "within_total"',
    "  CHECK (progress_total IS NULL OR progress_completed <= progress_total);--> statement-breakpoint",
    "CREATE FUNCTION guard() RETURNS trigger LANGUAGE plpgsql AS $$",
    "BEGIN",
    "  IF NEW.applied IS NULL OR NEW.applied < OLD.applied THEN",
    "    RAISE EXCEPTION 'applied epoch cannot decrease';",
    "  END IF;",
    "  SELECT id INTO next_id FROM runs ORDER BY id LIMIT 1;",
    "  RETURN NEW;",
    "END;",
    "$$;",
  ].join("\n");
  expect(migrationHitLines(source)).toEqual([]);
});

test("a migration hit takes a reason, and an unused reason is an error", () => {
  expect(
    analyzeMigrationSqlPerf(
      ROUTINE_PAGE("(after_id IS NULL OR id > after_id)").replace(
        "    WHERE",
        "    -- sql-perf-allow: small table queue_heads\n    WHERE",
      ),
    ),
  ).toEqual({ hits: [], commentErrors: [] });
  expect(
    analyzeMigrationSqlPerf(
      `-- sql-perf-allow: small table queue_heads\n${ROUTINE_PAGE("id > after_id")}`,
    ).commentErrors,
  ).toEqual([
    {
      line: 1,
      message: "sql-perf-allow suppresses no SQL performance finding.",
    },
  ]);
});

test("reads every migration but the exempt ones, whatever its date", async () => {
  expect(
    isSqlPerfMigration(
      "apps/api/drizzle/20260929180100_case_law_provision_scope_transition_keyset/migration.sql",
    ),
  ).toBe(true);
  // Migrations are not ordered, so an older date is no exemption.
  expect(
    isSqlPerfMigration("apps/api/drizzle/20200101000000_rebased/migration.sql"),
  ).toBe(true);
  expect(
    isSqlPerfMigration(
      "apps/api/drizzle/20260926170000_case_law_provision_backfill/migration.sql",
    ),
  ).toBe(false);
  expect(isSqlPerfMigration("apps/api/drizzle/meta/_journal.json")).toBe(false);
  // The shape the check exists for: the applied migration it replaces has it,
  // the replacement does not.
  expect(
    migrationHitLines(
      await Bun.file(
        "apps/api/drizzle/20260926170000_case_law_provision_backfill/migration.sql",
      ).text(),
    ),
  ).toHaveLength(1);
  expect(
    migrationHitLines(
      await Bun.file(
        "apps/api/drizzle/20260929180100_case_law_provision_scope_transition_keyset/migration.sql",
      ).text(),
    ),
  ).toEqual([]);
});

test.each([
  [
    "parameterized string",
    'query("SELECT count(*) FROM case_law_decisions WHERE source_id = $1", [source])',
  ],
  [
    "tagged template",
    "sql`SELECT COUNT ( * ) FROM ${caseLawDecisions} WHERE ${caseLawDecisions.sourceId} = ${source}`",
  ],
  [
    "untagged template",
    "query(`SELECT count(*) FROM ${caseLawDecisions} WHERE source_id = $1`)",
  ],
  [
    "quoted schema relation",
    'sql`SELECT count(*) FROM "public"."case_law_decisions" AS d WHERE d."source_id" = ${source}`',
  ],
  [
    "ineffective aggregate limit",
    "sql`SELECT count(*) FROM case_law_decisions WHERE source_id = ${source} LIMIT 1`",
  ],
  [
    "Drizzle count",
    'import { count, eq } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, source));',
  ],
  [
    "Drizzle SQL projection",
    'import { sql, eq } from "drizzle-orm"; db.select({ total: sql<number>`count(*)` }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, source));',
  ],
  [
    "import alias",
    'import { count as total, eq as equals } from "drizzle-orm"; const projection = { total: total() }; const predicate = equals(caseLawDecisions.sourceId, source); db.select(projection).from(caseLawDecisions).where(predicate);',
  ],
  [
    "namespace import",
    'import * as d from "drizzle-orm"; db.select({ total: d.count() }).from(caseLawDecisions).where(d.eq(caseLawDecisions.sourceId, source));',
  ],
  [
    "table const binding",
    'import { count, eq } from "drizzle-orm"; const table = caseLawDecisions; db.select({ total: count() }).from(table).where(eq(table.sourceId, source));',
  ],
  [
    "table alias",
    'import { count, eq, alias } from "drizzle-orm"; const decisions = alias(caseLawDecisions, "d"); db.select({ total: count() }).from(decisions).where(eq(decisions.sourceId, source));',
  ],
])("rejects per-source full counts: %s", (_, source) => {
  expect(kinds(source)).toContain("per-source-full-count");
});

test.each([
  [
    "direct SQL fragment",
    'import { count, sql } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(sql`${caseLawDecisions.sourceId} = ${sourceId}`);',
  ],
  [
    "SQL fragment inside and",
    'import { count, sql, and, eq } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(and(eq(caseLawDecisions.country, country), sql`${caseLawDecisions.sourceId} = ${sourceId}`));',
  ],
  [
    "aliased SQL tag and reversed equality",
    'import { count, sql as fragment } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(fragment`${sourceId} = ${caseLawDecisions.sourceId}`);',
  ],
  [
    "nested fragment bindings",
    'import { count, sql } from "drizzle-orm"; const sourceFilter = sql`${caseLawDecisions.sourceId} = ${sourceId}`; const predicate = sql`${sourceFilter}`; db.select({ total: count() }).from(caseLawDecisions).where(predicate);',
  ],
  [
    "table alias in fragment",
    'import { count, sql, alias } from "drizzle-orm"; const decisions = alias(caseLawDecisions, "d"); db.select({ total: count() }).from(decisions).where(sql`${decisions.sourceId} = ${sourceId}`);',
  ],
])("SQL fragment source restriction remains guarded: %s", (_, source) => {
  expect(kinds(source)).toContain("per-source-full-count");
});

test.each([
  'import { count, sql } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(sql`${caseLawDecisions.sourceId} = ${other.sourceId}`);',
  'import { count, sql, and, eq } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(and(eq(caseLawDecisions.country, country), sql`${other.sourceId} = ${caseLawDecisions.sourceId}`));',
  'import { count, sql } from "drizzle-orm"; const correlation = sql`${caseLawDecisions.sourceId} = ${other.sourceId}`; const predicate = sql`${correlation}`; db.select({ total: count() }).from(caseLawDecisions).where(predicate);',
])(
  "SQL fragment correlation remains outside the source-total guard: %s",
  (source) => {
    expect(kinds(source)).not.toContain("per-source-full-count");
  },
);

test.each([
  'query("SELECT count(*) FROM case_law_decisions WHERE source_id IN ($1)", [sourceId])',
  "sql`SELECT count(*) FROM case_law_decisions WHERE source_id IN (${sourceId})`",
  'import { count, sql } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(sql`${caseLawDecisions.sourceId} IN (${sourceId})`);',
  'import { count, inArray } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(inArray(caseLawDecisions.sourceId, [sourceId]));',
])(
  "single-value source membership has the same scan cost as equality: %s",
  (source) => {
    expect(kinds(source)).toContain("per-source-full-count");
  },
);

test.each([
  "sql`SELECT count(*) FROM case_law_decisions WHERE source_id IN ($1, $2)`",
  "sql`SELECT count(*) FROM case_law_decisions WHERE source_id IN (other.source_id)`",
  'import { count, sql } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(sql`${caseLawDecisions.sourceId} IN (${firstId}, ${secondId})`);',
  'import { count, inArray } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(inArray(caseLawDecisions.sourceId, [firstId, secondId]));',
  'import { count, inArray } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(inArray(caseLawDecisions.sourceId, [other.sourceId]));',
])(
  "multiple-source membership and singleton correlation remain out of scope: %s",
  (source) => {
    expect(kinds(source)).not.toContain("per-source-full-count");
  },
);

test("SQL fragment source counts require the same concrete exemption", () => {
  const source =
    'import { count, sql } from "drizzle-orm";\nconst total = db.select({ total: count() }).from(caseLawDecisions).where(sql`${caseLawDecisions.sourceId} = ${sourceId}`);';
  expect(kinds(source)).toContain("per-source-full-count");
  const exempted = source.replace(
    "const total",
    "// sql-perf-allow: bounded by an offline scheduled maintenance budget\nconst total",
  );
  expect(analyzeSqlPerf(exempted, "apps/api/src/handlers/example.ts")).toEqual({
    hits: [],
    commentErrors: [],
  });
});

test("every high-volume relation receives the per-source count guard", () => {
  for (const table of HIGH_VOLUME_TABLES) {
    expect(
      kinds(`sql\`SELECT count(*) FROM ${table} WHERE source_id = $1\``),
    ).toEqual(["per-source-full-count"]);
  }
});

test.each([
  "sql`SELECT source_id, count(*) FROM legislation_documents WHERE country = ${country} GROUP BY source_id`",
  'import { count, eq } from "drizzle-orm"; db.select({ source: legislationDocuments.sourceId, count: count() }).from(legislationDocuments).where(eq(legislationDocuments.country, country)).groupBy(legislationDocuments.sourceId);',
  "sql`SELECT source_id, count(*) FROM legislation_documents GROUP BY source_id`",
])(
  "grouped facet over a filtered set: out of scope of this rule: %s",
  (source) => {
    expect(kinds(source)).not.toContain("per-source-full-count");
  },
);

test.each([
  "sql`SELECT count(*) FROM legislation_documents work WHERE work.source_id = listed.source_id AND work.eli = listed.eli AND work.language = listed.language`",
  "const sameWork = sql`work.source_id = ${legislationDocuments.sourceId} AND work.eli = ${legislationDocuments.eli} AND work.language = ${legislationDocuments.language}`; const amendmentCount = sql`SELECT greatest(count(*) - 1, 0) FROM legislation_documents work WHERE ${sameWork}`;",
  'import { count, eq, and, alias } from "drizzle-orm"; const work = alias(legislationDocuments, "work"); db.select({ total: count() }).from(work).where(and(eq(work.sourceId, legislationDocuments.sourceId), eq(work.eli, legislationDocuments.eli), eq(work.language, legislationDocuments.language)));',
])(
  "correlated Work identity does not restrict a count to one source: %s",
  (source) => {
    expect(kinds(source)).not.toContain("per-source-full-count");
  },
);

test.each([
  "sql`SELECT count(*) FROM case_law_decisions WHERE source_id = '00000000-0000-0000-0000-000000000001'`",
  "sql`SELECT count(*) FROM case_law_decisions WHERE source_id = 42`",
  "sql`SELECT count(*) FROM case_law_decisions WHERE 42 = source_id`",
  "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON s.id = d.source_id WHERE s.adapter_key = 'cz-ns'`",
  "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON s.id = d.source_id WHERE 'cz-ns' = s.adapter_key`",
  'import * as d from "drizzle-orm"; db.select({ total: d.count() }).from(caseLawDecisions).where(d.eq(42, caseLawDecisions.sourceId));',
  'import { count, eq, and } from "drizzle-orm"; db.select({ total: count() }).from(legislationDocuments).where(and(eq(legislationDocuments.sourceId, sourceId), eq(legislationDocuments.eli, eli), eq(legislationDocuments.language, language)));',
])(
  "single-source equality remains guarded with fixed values and additional filters: %s",
  (source) => {
    expect(kinds(source)).toContain("per-source-full-count");
  },
);

test.each([
  "sql`SELECT stored_total FROM case_law_sources WHERE id = ${source}`",
  "sql`SELECT count(*) FROM small_settings WHERE source_id = ${source}`",
  "sql`SELECT count(*) FROM case_law_decisions WHERE id = ${id}`",
  "sql`SELECT reltuples FROM pg_class WHERE relname = 'case_law_decisions'`",
  "sql`SELECT 'count(*) source_id case_law_decisions'`",
  "sql`SELECT id FROM case_law_decisions WHERE source_id = ${source} /* count(*) */`",
  'query("SELECT count(*) FROM small_settings; SELECT id FROM case_law_decisions WHERE source_id = $1")',
  'import { count, eq } from "drizzle-orm"; db.select({ total: count() }).from(smallSettings).where(eq(smallSettings.sourceId, source));',
  'import { eq } from "drizzle-orm"; db.select({ id: caseLawDecisions.id }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, source));',
])("passes queries without a full per-source corpus count: %s", (source) => {
  expect(kinds(source)).toEqual([]);
});

test("per-source count findings cannot use a legacy baseline and need a visible concrete exemption", () => {
  expect(isBaselinedSqlPerfKind("per-source-full-count")).toBe(false);
  const query =
    "const total = sql`SELECT count(*) FROM case_law_decisions WHERE source_id = ${source}`;";
  expect(kinds(query)).toEqual(["per-source-full-count"]);
  const allowed = analyzeSqlPerf(
    `// sql-perf-allow: bounded by an offline scheduled maintenance budget\n${query}`,
    "apps/api/src/handlers/example.ts",
  );
  expect(allowed.hits).toEqual([]);
  expect(allowed.commentErrors).toEqual([]);
  expect(
    kinds(`const note = "// sql-perf-allow: bounded by a budget";\n${query}`),
  ).toEqual(["per-source-full-count"]);
});

test.each([
  [
    "source restriction inside join",
    "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON s.id = d.source_id AND d.source_id = ${sourceId}`",
  ],
  [
    "reverse join restriction",
    "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON ${sourceId} = d.source_id AND s.id = d.source_id`",
  ],
  [
    "raw join restriction",
    'query("SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON d.source_id = $1 AND s.id = d.source_id")',
  ],
  [
    "filtered replay counts",
    'import { sql, and, eq, isNull } from "drizzle-orm"; db.select({ stored: sql<string>`count(*) filter (where ${caseLawDecisions.sourceRawS3Key} is not null)`, refetch: sql<string>`count(*) filter (where ${caseLawDecisions.sourceRawS3Key} is null)` }).from(caseLawDecisions).where(and(eq(caseLawDecisions.sourceId, sourceId), isNull(caseLawDecisions.redactedAt)));',
  ],
])("source aggregation remains guarded with %s", (_, source) => {
  expect(kinds(source)).toContain("per-source-full-count");
});

test.each([
  [
    "citation authority for one decision",
    "sql`SELECT count(*) AS cnt FROM case_law_citations c JOIN case_law_decisions citing_d ON citing_d.id = c.citing_decision_id JOIN case_law_sources citing_src ON citing_src.id = citing_d.source_id WHERE c.cited_decision_id = ${decisionId}`",
  ],
  [
    "bounded authority batch",
    "sql`WITH batch AS (SELECT d.id FROM case_law_decisions d ORDER BY d.id LIMIT ${limit}), agg AS (SELECT b.id, count(c.id) FROM batch b LEFT JOIN case_law_citations c ON c.cited_decision_id = b.id JOIN case_law_decisions citing_d ON citing_d.id = c.citing_decision_id JOIN case_law_sources s ON s.id = citing_d.source_id GROUP BY b.id) SELECT (SELECT count(*) FROM batch) AS scanned, (SELECT count(*) FROM agg) AS written`",
  ],
  [
    "legislation country facets",
    "import { sql, eq, and } from \"drizzle-orm\"; db.select({ value: legislationDocuments.documentType, count: sql<number>`count(*)::integer` }).from(legislationDocuments).innerJoin(legislationSources, eq(legislationSources.id, legislationDocuments.sourceId)).where(and(eq(legislationDocuments.country, country), sql`${legislationDocuments.documentType} <> ''`)).groupBy(legislationDocuments.documentType);",
  ],
  [
    "source projection alone",
    'import { count, eq } from "drizzle-orm"; db.select({ source: caseLawDecisions.sourceId, count: count() }).from(caseLawDecisions).where(eq(caseLawDecisions.country, country));',
  ],
  [
    "raw source projection alone",
    "sql`SELECT min(source_id), count(*) FROM case_law_decisions WHERE country = ${country}`",
  ],
])(
  "source columns outside filtering and grouping do not trigger the guard: %s",
  (_, source) => {
    expect(kinds(source)).not.toContain("per-source-full-count");
  },
);

test.each([
  "sql`SELECT count(1) FROM case_law_decisions WHERE source_id = ${source}`",
  "sql`SELECT count(d.id) FROM case_law_decisions d WHERE d.source_id = $1`",
  "sql`SELECT count(d.fulltext) FROM case_law_decisions d WHERE d.source_id = $1`",
  "sql`SELECT count(DISTINCT d.id) FROM case_law_decisions d WHERE d.source_id = $1`",
  'import { count, eq } from "drizzle-orm"; db.select({ total: count(caseLawDecisions.id) }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, source));',
  'import { sql, eq } from "drizzle-orm"; db.select({ total: sql<number>`count(${caseLawDecisions.fulltext})` }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, source));',
  "sql`SELECT count(*) FROM ${caseLawDecisions} d JOIN case_law_sources s ON ${caseLawDecisions.sourceId} = ${sourceId}`",
])(
  "changing the count operand preserves the source scan guard: %s",
  (source) => {
    expect(kinds(source)).toContain("per-source-full-count");
  },
);

test("a Drizzle join source restriction is guarded while a source correlation is not", () => {
  const prefix =
    'import { count, eq, and } from "drizzle-orm"; db.select({ total: count(caseLawDecisions.id) }).from(caseLawDecisions)';
  expect(
    kinds(
      `${prefix}.innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId));`,
    ),
  ).not.toContain("per-source-full-count");
  expect(
    kinds(
      `${prefix}.innerJoin(caseLawSources, and(eq(caseLawSources.id, caseLawDecisions.sourceId), eq(caseLawDecisions.sourceId, sourceId)));`,
    ),
  ).toContain("per-source-full-count");
});

test.each([
  [
    "Drizzle dollar count",
    'import { eq } from "drizzle-orm"; db.$count(caseLawDecisions, eq(caseLawDecisions.sourceId, sourceId));',
  ],
  [
    "dollar count predicate binding",
    'import { eq } from "drizzle-orm"; const predicate = eq(caseLawDecisions.sourceId, sourceId); db.$count(caseLawDecisions, predicate);',
  ],
  [
    "source adapter restriction",
    "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON s.id = d.source_id WHERE s.adapter_key = $1`",
  ],
  [
    "source restriction inside join",
    "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON s.id = d.source_id AND s.adapter_key = $1`",
  ],
  [
    "tagged source table join",
    "sql`SELECT count(*) FROM ${caseLawDecisions} d JOIN ${caseLawSources} s ON s.id = d.source_id WHERE s.adapter_key = ${adapterKey}`",
  ],
  [
    "Drizzle adapter join",
    'import { count, eq } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId)).where(eq(caseLawSources.adapterKey, key));',
  ],
  [
    "sum one",
    "sql`SELECT sum(1) FROM case_law_decisions WHERE source_id = $1`",
  ],
  [
    "Drizzle sum one",
    'import { sql, eq } from "drizzle-orm"; db.select({ total: sql<number>`sum(1)` }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, sourceId));',
  ],
  [
    "sum a constant binding",
    'import { sql, eq } from "drizzle-orm"; const one = 1; db.select({ total: sql<number>`sum(${one})` }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, sourceId));',
  ],
  [
    "filter after a subquery FROM",
    "sql`SELECT count(*) FROM case_law_decisions d WHERE EXISTS (SELECT 1 FROM flags f) AND d.source_id = $1`",
  ],
  [
    "filter after a nested WHERE",
    "sql`SELECT count(*) FROM case_law_decisions d WHERE EXISTS (SELECT 1 FROM flags f WHERE f.enabled = true) AND d.source_id = $1`",
  ],
  [
    "nested whitespace in a source-id join restriction",
    "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON d.source_id = ( ( $1 ) ) AND s.id = d.source_id`",
  ],
  [
    "nested whitespace in a source alias join restriction",
    "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON s.adapter_key = ( ( $1 ) ) AND s.id = d.source_id`",
  ],
  [
    "parenthesized join restriction",
    "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON d.source_id = (${sourceId}) AND s.id = d.source_id`",
  ],
])("equivalent source scan remains guarded: %s", (_, source) => {
  expect(kinds(source)).toContain("per-source-full-count");
});

test.each([
  'import { eq } from "drizzle-orm"; db.$count(smallSettings, eq(smallSettings.sourceId, sourceId));',
  'import { eq } from "drizzle-orm"; db.$count(caseLawDecisions, eq(caseLawDecisions.country, country));',
  "sql`SELECT sum(1) FROM small_settings WHERE source_id = $1`",
  "sql`SELECT sum(1) FROM case_law_decisions WHERE country = $1`",
  "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON s.id = d.source_id WHERE d.country = $1`",
  "sql`SELECT count(*) FROM case_law_citations c JOIN case_law_decisions d ON d.id = c.citing_decision_id JOIN case_law_sources s ON s.id = d.source_id WHERE c.cited_decision_id = $1`",
  "sql`SELECT count(*) FROM case_law_decisions d WHERE EXISTS (SELECT f.source_id FROM flags f WHERE f.id = d.id) AND d.country = $1`",
  'import { count, eq } from "drizzle-orm"; db.select({ total: count() }).from(legislationDocuments).innerJoin(legislationSources, eq(legislationSources.id, legislationDocuments.sourceId)).where(eq(legislationDocuments.country, country)).groupBy(legislationDocuments.documentType);',
])("unrelated aggregate remains outside the per-source guard: %s", (source) => {
  expect(kinds(source)).not.toContain("per-source-full-count");
});

test("the scheduled exact source snapshot exemption remains visible and concrete", () => {
  const source =
    "// sql-perf-allow: bounded by an index-served exact source snapshot, one source/day and one per cycle, 120s\nconst total = sql`SELECT count(*) FROM case_law_decisions WHERE source_id = ${sourceId}`;";
  expect(
    analyzeSqlPerf(source, "apps/api/src/handlers/example.ts"),
  ).toMatchObject({ hits: [], commentErrors: [] });
});

test("counting one corpus row by primary key is outside the source-total guard", () => {
  expect(
    kinds(
      'import { count, eq } from "drizzle-orm"; db.select({ total: count() }).from(caseLawDecisions).where(eq(caseLawDecisions.id, decisionId));',
    ),
  ).not.toContain("per-source-full-count");
  expect(
    kinds(
      'import { eq } from "drizzle-orm"; db.$count(caseLawDecisions, eq(caseLawDecisions.id, decisionId));',
    ),
  ).not.toContain("per-source-full-count");
});

test("Drizzle sum of a literal unit has the same source scan cost as count", () => {
  expect(
    kinds(
      'import { sum, sql, eq } from "drizzle-orm"; db.select({ total: sum(sql<number>`1`) }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, sourceId));',
    ),
  ).toContain("per-source-full-count");
  expect(
    kinds(
      'import { sum, eq } from "drizzle-orm"; db.select({ total: sum(caseLawDecisions.pageCount) }).from(caseLawDecisions).where(eq(caseLawDecisions.sourceId, sourceId));',
    ),
  ).not.toContain("per-source-full-count");
});

test("source relation aliases and reversed adapter restrictions remain guarded", () => {
  expect(
    kinds(
      "sql`SELECT count(*) FROM case_law_decisions d JOIN case_law_sources s ON $1 = s.adapter_key AND s.id = d.source_id`",
    ),
  ).toContain("per-source-full-count");
  expect(
    kinds(
      'import { count, eq, alias } from "drizzle-orm"; const sources = alias(caseLawSources, "s"); db.select({ total: count() }).from(caseLawDecisions).innerJoin(sources, eq(sources.id, caseLawDecisions.sourceId)).where(eq(sources.adapterKey, key));',
    ),
  ).toContain("per-source-full-count");
});

test.each([
  ["self-recursive closure", "const predicate = () => predicate();"],
  [
    "mutually recursive closures",
    "const predicate = () => alternate(); const alternate = () => predicate();",
  ],
  [
    "closure alias cycle",
    "const predicate = () => alias(); const alias = predicate;",
  ],
  [
    "initializer containing its declaration",
    "const predicate = () => { const selected = predicate(); return selected; };",
  ],
])(
  "source count traversal terminates on %s and still detects the later restriction",
  (_, declarations) => {
    const source = `import { count, eq, and } from "drizzle-orm";
    ${declarations}
    db.select({ total: count() }).from(caseLawDecisions)
      .where(and(predicate(), eq(caseLawDecisions.sourceId, sourceId)));`;
    expect(kinds(source)).toContain("per-source-full-count");
    expect(
      kinds(
        source.replace("caseLawDecisions.sourceId", "caseLawDecisions.country"),
      ),
    ).not.toContain("per-source-full-count");
  },
);
