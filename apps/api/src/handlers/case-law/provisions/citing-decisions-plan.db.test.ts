/**
 * A provision's cited-by page reads decisions and link rows for the page, not
 * for the provision's whole citing set.
 *
 * The fixture cites one provision thousands of times, at one size and at
 * twice that size. Each page is run under `EXPLAIN (ANALYZE)`, and the
 * executed plan must join at most one decision per page row (plus the row
 * that marks a next page), read at most one link row from the heap per page
 * row, and take the subtree's own rows from the index alone. Those counts
 * must be the same at both sizes. A shape that ranks the whole citing set
 * before its limit (a window over every mention, or a join of every citing
 * decision) fails all three.
 *
 * The newest decision at each size also cites hundreds of other provisions
 * ahead of its first mention of this one, a different number at each size,
 * so a first-mention lookup that walks a decision's mentions in text order
 * reads them and fails the same bounds.
 */

import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { PROVISION_CITING_SNAPSHOT_LIMIT } from "@stll/api-contract/provision-citing-decisions";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
} from "@/api/db/schema";
import {
  citingDecisionConditions,
  citingDecisionsPageQuery,
  citingJurisdictionScope,
  decodeCitingDecisionsCursor,
  encodeCitingDecisionsCursor,
} from "@/api/handlers/case-law/provisions/citing-decisions";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";
import { vacuumUntilAllVisible } from "@/api/tests/query-plans/visibility";

const WORK = "89/2012 Sb.";
const WORK_ELI = "/eli/cz/sb/2012/89";
const ANCHOR = "par_2910";
/** Decisions citing the provision at the first size; each cites it twice. */
const CITING_DECISIONS = 1500;
const PAGE_SIZE = 20;
/** Other provisions the newest decision cites first, at each size. */
const UNRELATED_MENTIONS = { small: 300, large: 1200 } as const;

const sourceId = createSafeId<"caseLawSource">();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/**
 * Decisions `from` to `to`, each citing the section and its first
 * subsection, dated one day apart so the newest decision has the highest
 * number. A neighbouring section's citation sits beside each, outside the
 * subtree. The newest decision, `to`, first cites `unrelatedMentions` other
 * sections of the act, all of them ahead of its first mention of the
 * section.
 */
const seedCitingDecisions = async (
  from: number,
  to: number,
  unrelatedMentions: number,
) => {
  await db.execute(sql`
    INSERT INTO ${caseLawDecisions}
      (id, source_id, case_number, court, country, language, source_url,
       decision_date, citation_authority)
    SELECT
      md5('citing-plan-decision-' || n::text)::uuid,
      ${sourceId}::uuid,
      'citing-plan-' || n::text,
      'Court',
      'CZE',
      'cs',
      'https://example.test/decision/' || n::text,
      DATE '2000-01-01' + n,
      n % 10
    FROM generate_series(${from}::integer, ${to}::integer) AS generated(n)
  `);
  await db.execute(sql`
    INSERT INTO ${caseLawProvisionCitations}
      (id, decision_id, jurisdiction, work_identifier, work_eli, work_number,
       work_year, work_collection, unit, section, anchor, decision_date,
       sentence_text, span_start, span_end, confidence)
    SELECT
      md5('citing-plan-link-' || n::text || '-' || mention.anchor)::uuid,
      md5('citing-plan-decision-' || n::text)::uuid,
      'CZE', ${WORK}::text, ${WORK_ELI}::text, 89, 2012, 'Sb.', 'section',
      mention.section, mention.anchor, DATE '2000-01-01' + n,
      'sentence ' || mention.anchor || ' ' || n::text,
      mention.span_start, mention.span_start + 10, 0.9
    FROM generate_series(${from}::integer, ${to}::integer) AS generated(n)
    CROSS JOIN (
      VALUES
        (2910, ${ANCHOR}::text, 10),
        (2910, ${`${ANCHOR}-odst_1`}::text, 40),
        (2911, 'par_2911', 70)
    ) AS mention(section, anchor, span_start)
  `);
  await db.execute(sql`
    INSERT INTO ${caseLawProvisionCitations}
      (id, decision_id, jurisdiction, work_identifier, work_eli, work_number,
       work_year, work_collection, unit, section, anchor, decision_date,
       sentence_text, span_start, span_end, confidence)
    SELECT
      md5('citing-plan-unrelated-' || ${to}::text || '-' || k::text)::uuid,
      md5('citing-plan-decision-' || ${to}::text)::uuid,
      'CZE', ${WORK}::text, ${WORK_ELI}::text, 89, 2012, 'Sb.', 'section',
      k, 'par_' || k::text, DATE '2000-01-01' + ${to}::integer,
      'sentence par_' || k::text,
      k % 10, k % 10 + 5, 0.9
    FROM generate_series(1, ${unrelatedMentions}::integer) AS generated(k)
  `);
  await vacuumUntilAllVisible({ db, table: "case_law_decisions" });
  await vacuumUntilAllVisible({ db, table: "case_law_provision_citations" });
};

// timeout: builds the PGlite schema, then seeds and vacuums 4,800 link rows.
beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db
      .insert(caseLawSources)
      .values(
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      );
    await seedCitingDecisions(1, CITING_DECISIONS, UNRELATED_MENTIONS.small);
  },
  { timeout: 120_000 },
);

afterAll(async () => await client.close());

type PlanNode = Record<string, unknown>;

const planNodes = (node: PlanNode): PlanNode[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("EXPLAIN plan has malformed children");
  }
  return [node, ...children.flatMap(planNodes)];
};

const numberField = (node: PlanNode, name: string): number => {
  const value = node[name];
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number"
    ? value
    : panic(`EXPLAIN field ${name} is not a number`);
};

/** What one executed page read, counted from its plan. */
type PageReads = {
  /** Window nodes: a mention window ranks every row it is given. */
  windows: number;
  /** Decision rows read, kept or filtered, across all loops. */
  decisionRows: number;
  /** Link rows read from the heap, kept or filtered, across all loops. */
  linkHeapRows: number;
  /** Heap pages the index-only subtree range had to visit. */
  subtreeHeapFetches: number;
  /** Index-only reads of the link table: the subtree range. */
  subtreeRanges: number;
};

const pageReads = (root: PlanNode): PageReads => {
  const reads: PageReads = {
    windows: 0,
    decisionRows: 0,
    linkHeapRows: 0,
    subtreeHeapFetches: 0,
    subtreeRanges: 0,
  };
  for (const node of planNodes(root)) {
    const nodeType = node["Node Type"];
    const relation = node["Relation Name"];
    const rowsRead =
      (numberField(node, "Actual Rows") +
        numberField(node, "Rows Removed by Filter")) *
      numberField(node, "Actual Loops");
    if (nodeType === "WindowAgg") {
      reads.windows += 1;
    }
    if (relation === "case_law_decisions") {
      reads.decisionRows += rowsRead;
    }
    if (relation !== "case_law_provision_citations") {
      continue;
    }
    if (nodeType === "Index Only Scan") {
      reads.subtreeRanges += 1;
      reads.subtreeHeapFetches += numberField(node, "Heap Fetches");
    } else {
      reads.linkHeapRows += rowsRead;
    }
  }
  return reads;
};

type PageRequest = {
  sort: "newest" | "citations";
  limit: number;
  cursor: string | null;
};

const scope =
  citingJurisdictionScope("CZE") ?? panic("CZE must be a public jurisdiction");
const conditions =
  citingDecisionConditions(
    { jurisdiction: "CZE", work: WORK, anchor: ANCHOR },
    scope,
  ) ?? panic("The request names one work key");

const runPage = async ({ sort, limit, cursor }: PageRequest) =>
  await withPublicLawReaderRole(db, async (roleTx) => {
    // The corpus table holds every work's links, so the subtree is a sliver
    // of it; this fixture's table is only the subtree, where a sequential
    // scan would win and measure nothing.
    await roleTx.execute(sql`SET LOCAL enable_seqscan = off`);
    await roleTx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    // SAFETY: the role transaction has the same Drizzle read surface as the
    // public-law handle.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite test transaction stands in for the public read handle
    const tx = roleTx as unknown as CaseLawPublicReadTransaction;
    const query = citingDecisionsPageQuery({
      tx,
      conditions,
      cursor:
        cursor === null
          ? null
          : (decodeCitingDecisionsCursor(cursor) ??
            panic("The test cursor must decode")),
      sort,
      limit,
    });
    const rows = await query;
    const explained = await roleTx.execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query.getSQL()}`,
    );
    return { rows, reads: pageReads(explainRoot(explained)) };
  });

const newestDecisionIds = async (offset: number, count: number) =>
  executedRows(
    await db.execute(sql`
      SELECT id::text AS id FROM ${caseLawDecisions}
      ORDER BY decision_date DESC, id DESC
      OFFSET ${offset}::integer LIMIT ${count}::integer
    `),
  ).map((row) =>
    isRecord(row) && typeof row["id"] === "string"
      ? row["id"]
      : panic("Decision id is not text"),
  );

/** The first newest page, the page after it, and the citation-count snapshot. */
const measurePages = async () => {
  const first = await runPage({
    sort: "newest",
    limit: PAGE_SIZE,
    cursor: null,
  });
  const last =
    first.rows.at(PAGE_SIZE - 1) ?? panic("The first page must be full");
  const next = await runPage({
    sort: "newest",
    limit: PAGE_SIZE,
    cursor: encodeCitingDecisionsCursor({
      context: "0".repeat(64),
      decisionDate: last.decisionDateCursor,
      decisionId: last.decisionId,
    }),
  });
  const snapshot = await runPage({
    sort: "citations",
    limit: PROVISION_CITING_SNAPSHOT_LIMIT,
    cursor: null,
  });
  return { first, next, snapshot };
};

const expectPageBounded = (
  { rows, reads }: Awaited<ReturnType<typeof runPage>>,
  limit: number,
) => {
  expect(rows).toHaveLength(limit + 1);
  expect(reads.windows).toBe(0);
  expect(reads.subtreeRanges).toBe(1);
  expect(reads.subtreeHeapFetches).toBe(0);
  expect(reads.decisionRows).toBeLessThanOrEqual(limit + 1);
  expect(reads.linkHeapRows).toBeLessThanOrEqual(limit + 1);
};

// timeout: seeds and vacuums a second 5,700 link rows, then analyzes six pages.
test("a cited-by page reads decisions and link rows for the page, at any citing-set size", async () => {
  const small = await measurePages();
  expectPageBounded(small.first, PAGE_SIZE);
  expectPageBounded(small.next, PAGE_SIZE);
  expectPageBounded(small.snapshot, PROVISION_CITING_SNAPSHOT_LIMIT);

  // Each decision is listed once, newest first, with both its mentions
  // under the section and its earliest one as the excerpt.
  expect(small.first.rows.map(({ decisionId }) => String(decisionId))).toEqual(
    await newestDecisionIds(0, PAGE_SIZE + 1),
  );
  expect(small.next.rows.map(({ decisionId }) => String(decisionId))).toEqual(
    await newestDecisionIds(PAGE_SIZE, PAGE_SIZE + 1),
  );
  for (const row of small.first.rows) {
    expect(row.mentionCount).toBe(2);
    expect(row.spanStart).toBe(10);
  }

  await seedCitingDecisions(
    CITING_DECISIONS + 1,
    CITING_DECISIONS * 2,
    UNRELATED_MENTIONS.large,
  );
  const large = await measurePages();
  // The newest decision leads the page with its own first mention, past the
  // other provisions it cites first.
  expect(large.first.rows.at(0)).toMatchObject({
    mentionCount: 2,
    spanStart: 10,
  });
  expectPageBounded(large.first, PAGE_SIZE);
  expectPageBounded(large.next, PAGE_SIZE);
  expectPageBounded(large.snapshot, PROVISION_CITING_SNAPSHOT_LIMIT);

  // Twice the citing set and four times the newest decision's other
  // mentions, the same reads outside the subtree range.
  for (const page of ["first", "next", "snapshot"] as const) {
    expect(large[page].reads.decisionRows).toBe(small[page].reads.decisionRows);
    expect(large[page].reads.linkHeapRows).toBe(small[page].reads.linkHeapRows);
  }
}, 120_000);
