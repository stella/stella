import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig, getViewConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import {
  SITEMAP_LANGUAGE_GROUP_INDEX,
  SITEMAP_MONTH_INDEX,
} from "@/api/db/case-law-sitemap-indexes";
import {
  caseLawDecisions,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import {
  getShardConditions,
  sitemapShardDecisionsQuery,
} from "@/api/handlers/case-law/decisions/sitemap";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { publishedCaseLawDecisionIndexPredicateSql } from "@/api/lib/case-law/published-decisions-sql";
import { sitemapMonthCountSql } from "@/api/lib/case-law/sitemap-shard-refresh";
import { LIMITS } from "@/api/lib/limits";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

/**
 * A month of a country's decisions, each probing its language group twice. The
 * plan registry's synthetic profile keeps partial indexes at their seed size,
 * so this measures the heap rows a read visits on real rows: every row of a
 * scan that reads the heap, and each heap fetch of an index-only scan.
 */

const COUNTRY = "CZE";
const SOURCE_ID = "00000000-0000-7000-8000-000000000001";
const MONTH = { country: COUNTRY, year: "2020", month: "03" } as const;
const ROWS = 40_000;
/** One decision in this many falls in the month, as a month is a small part of a country. */
const MONTH_SHARE = 20;
const ROWS_IN_MONTH = ROWS / MONTH_SHARE;

type PlanNode = Record<string, unknown>;

const planNodes = (node: PlanNode): PlanNode[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("Sitemap plan children are malformed");
  }
  return [node, ...children.flatMap(planNodes)];
};

const countField = (node: PlanNode, field: string): number => {
  const value = node[field] ?? 0;
  return typeof value === "number"
    ? value
    : panic(`Sitemap plan field ${field} is not a number`);
};

const isDecisionScan = (node: PlanNode): boolean =>
  node["Relation Name"] === "case_law_decisions";

/** Heap rows a scan of the decisions visited, over all its loops. */
const heapRowsVisited = (node: PlanNode): number => {
  const loops = countField(node, "Actual Loops");
  // Only an index-only scan reports heap fetches.
  return node["Heap Fetches"] !== undefined
    ? countField(node, "Heap Fetches") * loops
    : (countField(node, "Actual Rows") +
        countField(node, "Rows Removed by Filter") +
        countField(node, "Rows Removed by Index Recheck")) *
        loops;
};

// timeout: an embedded Postgres seeds 40,000 rows and builds and vacuums their indexes twice.
test("a sitemap month and a shard page read the heap only for the page's rows", async () => {
  const client = new PGlite();
  try {
    for (const table of [caseLawSources, caseLawDecisions]) {
      const { columns, name } = getTableConfig(table);
      const declared = columns.map(
        (column) => `"${column.name}" ${column.getSQLType()}`,
      );
      await client.exec(`CREATE TABLE ${name} (${declared.join(", ")})`);
    }
    const db = drizzle({ client });
    const view = getViewConfig(publishedCaseLawDecisions);
    await db.execute(
      sql`CREATE VIEW ${sql.identifier(view.name)} AS (${sql.raw(
        new PgDialect().sqlToQuery(view.query).sql,
      )})`,
    );
    await db.execute(sql`
      INSERT INTO case_law_sources (id, adapter_key, name)
      VALUES (${SOURCE_ID}::uuid, 'sitemap-plan', 'Sitemap plan fixture')
    `);
    // Rows of a month sit apart on the heap, as they arrive across its years:
    // every tenth decision shares a group with one in another language.
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, court, country, language, language_group_key,
         decision_date, updated_at, metadata)
      SELECT
        gen_random_uuid(),
        ${SOURCE_ID}::uuid,
        'D/' || n,
        'Court',
        ${COUNTRY},
        CASE WHEN n % 10 = 0 THEN 'en' ELSE 'cs' END,
        'group-' || CASE WHEN n % 10 = 0 THEN n - 5 ELSE n END,
        CASE WHEN n % ${MONTH_SHARE} = 0 THEN DATE '2020-03-01' + (n % 28)
          ELSE DATE '2010-01-01' + (n % 3000) END,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + n * INTERVAL '1 second',
        '{}'::jsonb
      FROM generate_series(1, ${ROWS}) AS n
    `);
    await client.exec(`
      ALTER TABLE case_law_sources ADD PRIMARY KEY (id);
      ALTER TABLE case_law_decisions ADD PRIMARY KEY (id);
    `);
    const vacuum = async () => {
      await client.exec("VACUUM (ANALYZE) case_law_decisions");
      await client.exec("VACUUM (ANALYZE) case_law_sources");
    };
    const heapRows = async (statement: SQL): Promise<number> => {
      const { sql: text, params } = new PgDialect().sqlToQuery(statement);
      const { rows } = await client.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
        params,
      );
      return planNodes(explainRoot(rows))
        .filter(isDecisionScan)
        .reduce((sum, node) => sum + heapRowsVisited(node), 0);
    };
    const shardConditions = getShardConditions({
      ...MONTH,
      bucket: "00",
    });
    if (!Array.isArray(shardConditions)) {
      return panic("The shard fixture must be valid");
    }
    const shardRead = async () =>
      await sitemapShardDecisionsQuery(
        asTestRaw<CaseLawPublicReadTransaction>(db),
        shardConditions,
      );

    // The month's index before it carried the language group, and the group's
    // index that holds only the key.
    await client.exec(`
      CREATE INDEX before_month ON case_law_decisions
        (country, decision_date, source_id, updated_at, id)
        WHERE ${publishedCaseLawDecisionIndexPredicateSql()};
      CREATE INDEX before_group ON case_law_decisions (language_group_key)
        WHERE language_group_key IS NOT NULL;
    `);
    await vacuum();
    const month = sitemapMonthCountSql(MONTH);
    const heapRowsBefore = await heapRows(month);
    expect(heapRowsBefore).toBeGreaterThan(2 * ROWS_IN_MONTH);
    const pageBefore = await shardRead();
    expect(pageBefore.length).toBeGreaterThan(0);

    await client.exec("DROP INDEX before_month; DROP INDEX before_group");
    const indexes = [SITEMAP_MONTH_INDEX, SITEMAP_LANGUAGE_GROUP_INDEX];
    for (const { createSql } of indexes) {
      await client.exec(
        createSql.replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX"),
      );
    }
    await vacuum();
    const { rows: definitions } = await client.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = ANY($1)",
      [indexes.map(({ name }) => name)],
    );
    expect(definitions).toEqual(
      expect.arrayContaining(
        indexes.map(({ name, definitionBody }) => ({
          indexdef: `CREATE INDEX ${name} ${definitionBody}`,
        })),
      ),
    );

    const heapRowsAfter = await heapRows(month);
    process.stdout.write(
      `Sitemap month heap rows: ${String(heapRowsBefore)} -> ${String(heapRowsAfter)}\n`,
    );
    expect(heapRowsAfter).toBe(0);

    const page = await shardRead();
    expect(page.map(({ id }) => id)).toEqual(pageBefore.map(({ id }) => id));
    expect(page.length).toBeLessThanOrEqual(
      LIMITS.caseLawSitemapShardUrlLimit + 1,
    );
    const pageHeapRows = await heapRows(
      sitemapShardDecisionsQuery(
        asTestRaw<CaseLawPublicReadTransaction>(db),
        shardConditions,
      ).getSQL(),
    );
    process.stdout.write(
      `Sitemap shard heap rows: ${String(pageHeapRows)} for ${String(page.length)} URLs\n`,
    );
    expect(pageHeapRows).toBeLessThanOrEqual(page.length);
  } finally {
    await client.close();
  }
}, 180_000);
