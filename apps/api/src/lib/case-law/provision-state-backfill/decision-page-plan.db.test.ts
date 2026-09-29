/**
 * The provision backfill walks the whole decision table in id order, one
 * page per unit, from a cursor it commits with each page. The scheduler binds
 * the cursor through a prepared statement, which PostgreSQL may run under a
 * generic plan: the plan is chosen once, without the cursor's value.
 *
 * A later page must therefore start at the cursor on the primary key under a
 * generic plan. A plan that walks the key from its start and filters reads
 * every earlier row on every page, so the whole walk grows with the square of
 * the table. The plans are checked under the fixture's statistics and again
 * with the table scaled up; the pages are also run for their contents.
 */

import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  BOOTSTRAP_PAGE_SIZE,
  decisionPageSql,
  ID_PAGE_SIZE,
} from "@/api/lib/case-law/provision-state-backfill/backfill";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import type { ScanOccurrence } from "@/api/tests/query-plans/plan-walker";

const DB_TEST_TIMEOUT_MS = 120_000;
const PRIMARY_KEY = "case_law_decisions_pkey";
const DECISION_ROWS = 20_000;
/** Synthetic table size for the scaled pass; a round number, not a measurement. */
const SCALED_DECISION_ROWS = 100_000_000;
const PAGE_SIZES = [ID_PAGE_SIZE, BOOTSTRAP_PAGE_SIZE] as const;

/**
 * Shapes the check must reject: the one statement with an optional bound,
 * ordered by the text output column, and the optional bound alone.
 */
const REJECTED_PAGE_SHAPES = [
  `SELECT id::text AS id FROM case_law_decisions
   WHERE ($1::uuid IS NULL OR id > $1::uuid)
   ORDER BY id LIMIT $2`,
  `SELECT id::text AS id FROM case_law_decisions
   WHERE ($1::uuid IS NULL OR id > $1::uuid)
   ORDER BY case_law_decisions.id LIMIT ${ID_PAGE_SIZE}`,
] as const;

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let middleId = "";

const readIds = (result: unknown): string[] =>
  executedRows(result).map((row) => {
    const id = isRecord(row) ? row["id"] : undefined;
    return typeof id === "string" ? id : panic("page row has no text id");
  });

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    const sourceId = createSafeId<"caseLawSource">();
    await db
      .insert(caseLawSources)
      .values(caseLawSourceRow({ id: sourceId, name: "provision page plan" }));
    // Random ids: the key order has no relation to the heap order, the
    // costlier case for an index walk.
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, court, country, language, decision_date,
         metadata)
      SELECT gen_random_uuid(), ${sourceId}::uuid, 'page-' || i,
        'Nejvyšší soud', 'CZE', 'cs', DATE '2020-01-01' + (i % 1500),
        '{}'::jsonb
      FROM generate_series(1, ${DECISION_ROWS}::int) AS i
    `);
    await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
    const [row] = executedRows(
      await db.execute(sql`
        SELECT id::text AS id FROM case_law_decisions
        ORDER BY id OFFSET ${DECISION_ROWS / 2} LIMIT 1
      `),
    );
    const id = isRecord(row) ? row["id"] : undefined;
    middleId = typeof id === "string" ? id : panic("fixture has no middle id");
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

/**
 * The decision scans of `text` prepared and explained under a generic plan,
 * with `cursor` bound when the statement takes one.
 */
const genericPlanScans = async (
  text: string,
  cursor: string | null,
): Promise<ScanOccurrence[]> => {
  const takesCursor = text.includes("$1");
  const takesSize = text.includes("$2");
  const types = [
    ...(takesCursor ? ["uuid"] : []),
    ...(takesSize ? ["integer"] : []),
  ];
  const values = [
    ...(takesCursor ? [cursor === null ? "NULL" : `'${cursor}'`] : []),
    ...(takesSize ? [String(ID_PAGE_SIZE)] : []),
  ];
  await client.exec("SET plan_cache_mode = force_generic_plan");
  await client.exec(
    `PREPARE decision_page${types.length > 0 ? `(${types.join(", ")})` : ""} AS ${text}`,
  );
  try {
    const explained = await client.query(
      `EXPLAIN (FORMAT JSON) EXECUTE decision_page${values.length > 0 ? `(${values.join(", ")})` : ""}`,
    );
    return scanOccurrences(explainRoot(explained)).filter(
      ({ relation }) => relation === "case_law_decisions",
    );
  } finally {
    await client.exec("DEALLOCATE decision_page");
    await client.exec("RESET plan_cache_mode");
  }
};

/**
 * The decision scans as the checks read them. A page is one index scan of the
 * primary key, in key order (no sort above it), with nothing filtered out.
 */
const pageWalk = async (text: string, cursor: string | null) => {
  const scans = await genericPlanScans(text, cursor);
  return scans.map(({ nodeType, index, indexCond, filter, position }) => ({
    indexScan: nodeType === "Index Scan" || nodeType === "Index Only Scan",
    index,
    boundedOnId: indexCond !== null && /\bid > /u.test(indexCond),
    filter,
    // Limit, then the scan: no sort between them.
    position,
  }));
};

const keysetWalk = (boundedOnId: boolean) => [
  {
    indexScan: true,
    index: PRIMARY_KEY,
    boundedOnId,
    filter: null,
    position: "root/0",
  },
];

/** Every page statement reads the primary key, a later one from its cursor. */
const expectKeysetPlans = async () => {
  for (const size of PAGE_SIZES) {
    expect(await pageWalk(decisionPageSql("after", size), middleId)).toEqual(
      keysetWalk(true),
    );
    expect(await pageWalk(decisionPageSql("first", size), null)).toEqual(
      keysetWalk(false),
    );
  }
};

test(
  "a later page starts at its cursor on the primary key under a generic plan",
  async () => {
    await expectKeysetPlans();
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the check rejects an optional bound and a sort on the text column",
  async () => {
    // Under a generic plan an optional bound is a filter, not an index
    // condition, so the page walks the table from its start.
    for (const text of REJECTED_PAGE_SHAPES) {
      expect(await pageWalk(text, middleId)).not.toEqual(keysetWalk(true));
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "consecutive pages return the table in id order without gaps",
  async () => {
    const ordered = readIds(
      await db.execute(
        sql`SELECT id::text AS id FROM case_law_decisions ORDER BY id LIMIT ${ID_PAGE_SIZE * 2}`,
      ),
    );
    const first = readIds(
      await client.query(decisionPageSql("first", ID_PAGE_SIZE)),
    );
    const cursor = first.at(-1) ?? panic("the first page is empty");
    const second = readIds(
      await client.query(decisionPageSql("after", ID_PAGE_SIZE), [cursor]),
    );
    expect([...first, ...second]).toEqual(ordered);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the pages keep the primary key when the table is scaled up",
  async () => {
    const [row] = executedRows(
      await db.execute(sql`
        SELECT pg_restore_relation_stats(
          'schemaname', 'public', 'relname', 'case_law_decisions',
          'reltuples', ${SCALED_DECISION_ROWS}::real,
          'relpages', (${SCALED_DECISION_ROWS}::double precision
            * relpages / reltuples)::integer
        ) AS restored
        FROM pg_class WHERE oid = 'case_law_decisions'::regclass
      `),
    );
    if (!isRecord(row) || row["restored"] !== true) {
      panic("could not scale the decision table's statistics");
    }
    await expectKeysetPlans();
  },
  DB_TEST_TIMEOUT_MS,
);
