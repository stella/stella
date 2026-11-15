import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import { DAY_IN_MS } from "@stll/time";

import {
  COURT_ACTIVITY_ARRIVALS_INDEX,
  COURT_ACTIVITY_LATEST_INDEX,
} from "@/api/db/case-law-court-activity-indexes";
import { caseLawPopulationProjections } from "@/api/db/schema";
import { courtActivityStatement } from "@/api/handlers/case-law/decisions/status-courts";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

/**
 * The coverage page's per-court breakdown on courts a reparse has just
 * rewritten: every row's `updated_at` is an hour old, and only a handful of
 * rows arrived this week. The breakdown must read about as many rows as
 * arrived, not the courts.
 *
 * Measured on real rows rather than through the plan registry: the registry's
 * synthetic profile scales the table but keeps each partial index at its seed
 * size, so the planner there believes a court holds a few dozen rows.
 */

const COUNTRY = "CZE";
const COURTS = ["Nejvyšší soud", "Ústavní soud"] as const;
const ROWS_PER_COURT = 10_000;
const ADDED_LAST_DAY = 5;
const ADDED_LAST_WEEK = 20;
const NOW = new Date("2026-11-04T12:00:00.000Z");
const REPARSED_AT = new Date(NOW.getTime() - DAY_IN_MS / 24);
const SINCE_WEEK = new Date(NOW.getTime() - 7 * DAY_IN_MS);
const SOURCE_ID = "00000000-0000-7000-8000-000000000001";

/** Rows the statement may read: each court's week, plus its newest row. */
const ROW_BUDGET = COURTS.length * (ADDED_LAST_WEEK + 1);

type PlanNode = Record<string, unknown>;

const planNodes = (node: PlanNode): PlanNode[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("Court activity plan children are malformed");
  }
  return [node, ...children.flatMap(planNodes)];
};

const countField = (node: PlanNode, field: string): number => {
  const value = node[field] ?? 0;
  return typeof value === "number"
    ? value
    : panic(`Court activity plan field ${field} is not a number`);
};

/** Rows a scan node produced or threw away, over all its loops. */
const examinedRows = (node: PlanNode): number =>
  (countField(node, "Actual Rows") +
    countField(node, "Rows Removed by Filter") +
    countField(node, "Rows Removed by Index Recheck")) *
  countField(node, "Actual Loops");

/**
 * The breakdown as it read before the arrivals index: the week bounded by
 * `updated_at`, the column a reparse rewrites, and counted by `created_at`.
 */
const updatedAtBoundedStatement = sql`
  SELECT named.court,
    count(*) FILTER (WHERE recent_decision.created_at >= ${SINCE_WEEK.toISOString()}::timestamptz) AS added_last_week
  FROM unnest(ARRAY[${COURTS[0]}, ${COURTS[1]}]::text[]) AS named(court)
  LEFT JOIN LATERAL (
    SELECT recent_decision.created_at
    FROM case_law_population_projections AS recent_decision
    WHERE recent_decision.publication = 'published'
      AND recent_decision.country = ${COUNTRY}
      AND recent_decision.court = named.court
      AND recent_decision.updated_at >= ${SINCE_WEEK.toISOString()}::timestamptz
  ) recent_decision ON true
  GROUP BY named.court
`;

// timeout: an embedded Postgres seeds 20,000 rows and analyzes them twice.
test("a reparsed court's breakdown reads its week's arrivals, not the court", async () => {
  const client = new PGlite();
  try {
    const columns = getTableConfig(caseLawPopulationProjections).columns.map(
      (column) => `"${column.name}" ${column.getSQLType()}`,
    );
    await client.exec(
      `CREATE TABLE case_law_population_projections (${columns.join(", ")})`,
    );
    const createIndex = async (index: { createSql: string }) =>
      await client.exec(
        index.createSql.replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX"),
      );
    await createIndex(COURT_ACTIVITY_LATEST_INDEX);
    const db = drizzle({ client });
    // Per court: a day's worth arrived in the last hours, a week's worth in
    // the last six days, and the rest more than a week back; then a reparse
    // stamped every row's updated_at an hour ago.
    await db.execute(sql`
      INSERT INTO case_law_population_projections
        (decision_id, source_id, country, buckets, court, created_at,
         updated_at, publication)
      SELECT
        gen_random_uuid(),
        ${SOURCE_ID}::uuid,
        ${COUNTRY},
        '{}'::jsonb,
        (ARRAY[${COURTS[0]}, ${COURTS[1]}]::text[])[court_index],
        CASE
          WHEN n <= ${ADDED_LAST_DAY}
            THEN ${NOW.toISOString()}::timestamptz - n * INTERVAL '2 hours'
          WHEN n <= ${ADDED_LAST_WEEK}
            THEN ${NOW.toISOString()}::timestamptz - n * INTERVAL '7 hours'
          ELSE ${NOW.toISOString()}::timestamptz - INTERVAL '8 days' - n * INTERVAL '1 hour'
        END,
        ${REPARSED_AT.toISOString()}::timestamptz,
        'published'
      FROM generate_series(1, ${COURTS.length}) AS courts(court_index),
        generate_series(1, ${ROWS_PER_COURT}) AS court_rows(n)
    `);
    const analyze = async () =>
      await client.exec("VACUUM (ANALYZE) case_law_population_projections");
    const projectionRowsRead = async (statement: SQL): Promise<number> => {
      const plan = explainRoot(
        await db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`),
      );
      return planNodes(plan)
        .filter(
          (node) => node["Relation Name"] === "case_law_population_projections",
        )
        .reduce((sum, node) => sum + examinedRows(node), 0);
    };
    await analyze();

    // Before the arrivals index, an updated_at bound reads every row the
    // reparse touched: both courts whole, for a count of twenty each.
    expect(await projectionRowsRead(updatedAtBoundedStatement)).toBe(
      COURTS.length * ROWS_PER_COURT,
    );

    await createIndex(COURT_ACTIVITY_ARRIVALS_INDEX);
    await analyze();
    const read = {
      country: COUNTRY,
      courts: COURTS,
      excludedSourceIds: [],
      now: NOW,
    };
    expect(
      executedRows(await db.execute(courtActivityStatement(read))),
    ).toEqual(
      COURTS.map((court) => ({
        court,
        updated_at: REPARSED_AT.toISOString().replace(".000Z", "+00:00"),
        added_last_day: ADDED_LAST_DAY,
        added_last_week: ADDED_LAST_WEEK,
      })),
    );
    const rowsRead = await projectionRowsRead(courtActivityStatement(read));
    process.stdout.write(`Court activity rows read: ${String(rowsRead)}\n`);
    expect(rowsRead).toBeLessThanOrEqual(ROW_BUDGET);
  } finally {
    await client.close();
  }
}, 120_000);
