import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { decisionTypeKindSql } from "@/api/lib/case-law/decision-type-filter-sql";
import { CASE_LAW_FILTER_SCOPE_INDEXES } from "@/api/lib/case-law/filter-scope-indexes";
import { publishedCaseLawDecisionIndexPredicateSql } from "@/api/lib/case-law/published-decisions-sql";

test("filter type indexes match PostgreSQL definitions and serve absent kind and stated-value probes", async () => {
  const db = new PGlite();
  await db.exec(
    `CREATE TABLE case_law_decisions (country varchar(3), decision_type varchar(128), metadata jsonb DEFAULT '{}', redacted_at timestamptz)`,
  );
  await db.exec(
    `INSERT INTO case_law_decisions(country, decision_type) SELECT 'CZE', 'rozsudek' FROM generate_series(1, 10000)`,
  );
  for (const index of CASE_LAW_FILTER_SCOPE_INDEXES) {
    await db.exec(index.createSql.replace(" CONCURRENTLY", ""));
    const definition = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname=$1",
      [index.name],
    );
    expect(definition.rows.at(0)?.indexdef).toBe(
      `CREATE INDEX ${index.name} ${index.definitionBody}`,
    );
  }
  await db.exec("ANALYZE case_law_decisions");
  const kind = new PgDialect().sqlToQuery(
    decisionTypeKindSql(sql.raw("decision_type")).inlineParams(),
  ).sql;
  for (const [expression, index] of [
    [`${kind} = 'resolution'`, CASE_LAW_FILTER_SCOPE_INDEXES[0]],
    ["lower(decision_type) = 'foreign-type'", CASE_LAW_FILTER_SCOPE_INDEXES[1]],
  ] as const) {
    const plan = await db.query(
      `EXPLAIN SELECT 1 FROM case_law_decisions WHERE country='CZE' AND ${expression} AND ${publishedCaseLawDecisionIndexPredicateSql()} LIMIT 1`,
    );
    expect(JSON.stringify(plan.rows)).toContain(index.name);
  }
  await db.close();
});
