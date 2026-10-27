import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type * as v from "valibot";

import {
  DECISION_LIST_SORTS,
  type DecisionListSort,
} from "@stll/api-contract/search";

import { caseLawSources } from "@/api/db/schema";
import {
  listDecisionsPageQuery,
  type listDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { planLines } from "@/api/tests/helpers/explain-plan";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const DECISIONS = 5000;
const DB_TEST_TIMEOUT_MS = 120_000;
const sourceId = createSafeId<"caseLawSource">();
/** One decision in fifty: a court whose walk must be its own index range. */
const SMALL_COURT = "Krajský soud v Brně";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: "browse",
        id: sourceId,
        name: "browse",
      }),
    ]);
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, citation_key, court, country, language,
         language_group_key, decision_type, decision_date, created_at)
      SELECT gen_random_uuid(), ${sourceId}::uuid, i || ' Cdo ' || i || '/2020',
        i || 'cdo' || i || '/2020',
        CASE WHEN i % 50 = 2 THEN ${SMALL_COURT} ELSE 'Nejvyšší soud' END,
        CASE WHEN i % 4 = 0 THEN 'SVK' ELSE 'CZE' END,
        CASE WHEN i % 10 = 3 THEN 'en' ELSE 'cs' END,
        CASE WHEN i % 4 = 1 THEN NULL ELSE 'group:' || (i / 3)::text END,
        CASE WHEN i % 3 = 0 THEN 'rozsudek' ELSE 'usnesení' END,
        DATE '2020-01-01' + (i % 97),
        TIMESTAMPTZ '2020-01-01' + (i || ' seconds')::interval
      FROM generate_series(1, ${DECISIONS}::int) AS i
    `);
    await db.execute(sql`ANALYZE case_law_decisions`);
    await db.execute(sql`ANALYZE case_law_sources`);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

/**
 * The scan each order reads the walk index with: a range read in one
 * direction, so the page limit stops it. Total over the orders, so a new one
 * does not compile until it states the direction its plan must show.
 */
const WALK_SCAN_NODE = {
  newest: "Index Scan Backward",
  oldest: "Index Scan",
} as const satisfies Record<DecisionListSort, string>;

/**
 * Where the walk starts. Oldest first skips the undated band as the start of
 * the index range, not as a filter over the rows the range returns.
 */
const DATED_BAND_COND = {
  newest: "\\)?\\n",
  oldest:
    " AND \\(COALESCE\\(decision_date, '-infinity'::date\\) > '-infinity'::date\\)\\)\\n",
} as const satisfies Record<DecisionListSort, string>;

test.each(DECISION_LIST_SORTS)(
  "the %s-first decision list keeps its index path with grouped and ungrouped rows",
  async (sort) => {
    const plans = await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the read uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      const query = listDecisionsPageQuery({
        query: { country: "CZE" },
        sort,
        limit: 50,
        cursor: undefined,
        tx,
      });
      const natural = planLines(
        await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${query.getSQL()}`),
      ).join("\n");
      const rows = await query;
      await roleTx.execute(sql`SET LOCAL enable_seqscan = off`);
      const forced = planLines(
        await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${query.getSQL()}`),
      ).join("\n");
      return { natural, forced, rows };
    });

    const scan = WALK_SCAN_NODE[sort];
    const indexedDecisionScan = new RegExp(
      `${scan} using case_law_decisions_country_date_published_idx on case_law_decisions\\n\\s+Index Cond: \\(+\\(country\\)::text = 'CZE'::text\\)${DATED_BAND_COND[sort]}`,
      "u",
    );
    expect(plans.natural).toMatch(indexedDecisionScan);
    expect(plans.forced).toMatch(indexedDecisionScan);
    for (const plan of [plans.natural, plans.forced]) {
      // The representative check is a subplan filter on the walk itself. As a
      // join (anti or lateral) the planner misjudges how many rows survive it
      // and sorts the whole country instead of stopping after one page.
      expect(plan).toMatch(
        new RegExp(
          `${scan} using case_law_decisions_country_date_published_idx on case_law_decisions\\n\\s+Index Cond: [^\\n]+\\n\\s+Filter: \\(NOT EXISTS\\(SubPlan \\d+\\)\\)`,
          "u",
        ),
      );
      expect(plan).not.toMatch(/Anti Join|Left Join/u);
      expect(plan.slice(0, plan.indexOf(`${scan} using`))).not.toMatch(
        /\b(Sort|Bitmap Heap Scan)\b/u,
      );
      expect(plan).toContain("case_law_decisions_lang_group_idx");
      expect(plan).toMatch(/Index Cond: .*language_group_key/u);
      expect(plan).not.toContain("Seq Scan on case_law_decisions");
    }
    expect(plans.rows.some((row) => row.languageGroupKey === null)).toBe(true);
    const groupKeys = plans.rows.flatMap((row) =>
      row.languageGroupKey === null ? [] : [row.languageGroupKey],
    );
    expect(new Set(groupKeys).size).toBe(groupKeys.length);
  },
  DB_TEST_TIMEOUT_MS,
);

type BrowseQuery = v.InferOutput<typeof listDecisionsQuerySchema>;
type BrowseFilter = Exclude<
  keyof BrowseQuery,
  "cursor" | "limit" | "offset" | "sort"
>;

/** The indexes whose order is the walk's: a page is a range of one of them. */
const walkScan = (sort: DecisionListSort) =>
  new RegExp(
    `${WALK_SCAN_NODE[sort]} using (case_law_decisions_country_date_published_idx|case_law_decisions_country_court_date_idx|case_law_decisions_corpus_generation_date_cursor_idx) on case_law_decisions\\n\\s+Index Cond: ([^\\n]+)`,
    "u",
  );

type FilterAccess =
  | {
      /** The walk's own index range narrows to the filter, read in order. */
      type: "walk-range";
      query: BrowseQuery;
      indexCond: RegExp;
    }
  | {
      /**
       * An index condition narrows to the filter: the walk itself, or, for a
       * selective value, a bitmap of only the matching rows sorted for the page.
       */
      type: "index-probe";
      query: BrowseQuery;
      indexCond: RegExp;
    }
  | {
      /** A filter on the walk: a page reads rows until it holds enough matches. */
      type: "walk-filter";
      query: BrowseQuery;
      reason: string;
    };

/**
 * How the browse walk serves each filter of the public query. Total over the
 * schema's filters, so a new filter does not compile until it states which
 * access path serves it, and the plan below proves the statement.
 */
const FILTER_ACCESS = {
  country: {
    type: "walk-range",
    query: { country: "CZE" },
    indexCond: /\(country\)::text = 'CZE'::text/u,
  },
  court: {
    type: "index-probe",
    query: { country: "CZE", court: SMALL_COURT },
    indexCond: /\(court\)::text = 'Krajský soud v Brně'::text/u,
  },
  dateFrom: {
    type: "walk-range",
    query: { country: "CZE", dateFrom: "2020-03-01" },
    indexCond:
      /COALESCE\(decision_date, '-infinity'::date\) >= '2020-03-01'::date/u,
  },
  dateTo: {
    type: "walk-range",
    query: { country: "CZE", dateTo: "2020-01-20" },
    indexCond:
      /COALESCE\(decision_date, '-infinity'::date\) <= '2020-01-20'::date/u,
  },
  decisionType: {
    type: "walk-filter",
    query: { country: "CZE", decisionType: "rozsudek" },
    reason: "a canonical kind folded from the stated type; no index holds it",
  },
  language: {
    type: "index-probe",
    query: { country: "CZE", language: "en" },
    indexCond: /\(language\)::text = 'en'::text/u,
  },
  sourceId: {
    type: "walk-filter",
    query: { country: "CZE", sourceId },
    reason: "no browse index is led by source",
  },
} as const satisfies Record<BrowseFilter, FilterAccess>;

const explainWalk = async (query: BrowseQuery, sort: DecisionListSort) =>
  await withPublicLawReaderRole(db, async (roleTx) => {
    // SAFETY: the role transaction supplies the select surface the read uses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
    const tx = roleTx as unknown as CaseLawPublicReadTransaction;
    const page = listDecisionsPageQuery({
      query,
      sort,
      limit: 50,
      cursor: undefined,
      tx,
    });
    const natural = planLines(
      await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${page.getSQL()}`),
    ).join("\n");
    await roleTx.execute(sql`SET LOCAL enable_seqscan = off`);
    const forced = planLines(
      await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${page.getSQL()}`),
    ).join("\n");
    return [natural, forced];
  });

/** A walk index read in order, with nothing above it re-sorting its rows. */
const orderedWalk = (plan: string, sort: DecisionListSort) => {
  const walk = walkScan(sort).exec(plan);
  expect(walk, plan).not.toBeNull();
  // The page limit stops the walk only when nothing above it re-sorts or
  // re-reads the rows it returns.
  expect(plan.slice(0, walk?.index)).not.toMatch(
    /\b(Sort|Bitmap Heap Scan)\b/u,
  );
  return walk;
};

test.each(
  DECISION_LIST_SORTS.flatMap((sort) =>
    Object.entries(FILTER_ACCESS).map(
      ([filter, access]) => [sort, filter, access] as const,
    ),
  ),
)(
  "the %s-first browse walk reads its %s filter through the access path it declares",
  async (sort, _filter, access) => {
    for (const plan of await explainWalk(access.query, sort)) {
      expect(plan).not.toContain("Seq Scan on case_law_decisions");
      switch (access.type) {
        case "walk-range":
          expect(orderedWalk(plan, sort)?.[2]).toMatch(access.indexCond);
          break;
        case "index-probe":
          expect(
            [...plan.matchAll(/Index Cond: ([^\n]+)/gu)].some(([, cond]) =>
              access.indexCond.test(cond ?? ""),
            ),
            plan,
          ).toBe(true);
          break;
        case "walk-filter":
          orderedWalk(plan, sort);
          break;
        default:
          access satisfies never;
      }
    }
  },
  DB_TEST_TIMEOUT_MS,
);
