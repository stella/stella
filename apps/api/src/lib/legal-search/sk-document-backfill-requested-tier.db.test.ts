/**
 * Keyset regression for the requested tier of the document backfill queue.
 *
 * `case_law_decisions.document_fetch_requested_at` is written only by SQL
 * `now()`, so it always carries microseconds. The tier pages oldest-first,
 * and an ascending `>` boundary that went through a JS `Date` still admits
 * the row the page was cut at: the queue would then re-emit that decision at
 * the head of every page and never reach the rest of the backlog. Only rows
 * with non-zero sub-millisecond digits can show that, so the fixture writes
 * the column with `now()`-shaped literals.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import { loadRequestedDocuments } from "@/api/lib/legal-search/sk-document-backfill";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const PAGE_LIMIT = 3;
/** A stalled cursor loops forever, so the walk is bounded. */
const MAX_PAGES = 40;

/**
 * Nine requests inside one millisecond, separated only by microseconds; the
 * last three share an exact timestamp so the id tie-break runs too. Every one
 * of them collapses onto the same JS `Date`.
 */
const REQUESTED_AT = [
  "2026-06-03 07:00:00.750001+00",
  "2026-06-03 07:00:00.750002+00",
  "2026-06-03 07:00:00.750003+00",
  "2026-06-03 07:00:00.750004+00",
  "2026-06-03 07:00:00.750005+00",
  "2026-06-03 07:00:00.750006+00",
  "2026-06-03 07:00:00.750007+00",
  "2026-06-03 07:00:00.750007+00",
  "2026-06-03 07:00:00.750007+00",
] as const;

let testDb: TestDatabase;
let scopedDb: ScopedDb;
let sourceId: SafeId<"caseLawSource">;
const created: SafeId<"caseLawDecision">[] = [];
const suffix = Bun.randomUUIDv7().slice(0, 8);

beforeAll(async () => {
  testDb = await getTestDb();
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: TestDatabase) => Promise<unknown>) =>
      await callback(testDb),
  );

  const [source] = await testDb
    .insert(caseLawSources)
    .values({
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      name: `SK requested-tier keyset ${suffix}`,
      enabled: false,
    })
    .returning({ id: caseLawSources.id });
  if (!source) {
    throw new Error("expected source row");
  }
  sourceId = source.id;

  for (const [index, requestedAt] of REQUESTED_AT.entries()) {
    const [row] = await testDb
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: `requested-${suffix}-${String(index).padStart(3, "0")}`,
        court: "Okresný súd",
        country: "SVK",
        language: "sk",
        fulltext: null,
        documentUrl: "https://example.test/requested.pdf",
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected decision row");
    }
    created.push(row.id);
    // The microsecond digits are the point of the fixture, so the column is
    // written as a literal rather than bound from a `Date`.
    await testDb.execute(sql`
      UPDATE case_law_decisions
      SET document_fetch_requested_at = ${requestedAt}::timestamptz
      WHERE id = ${row.id}
    `);
  }
}, 120_000);

afterAll(async () => {
  if (created.length > 0) {
    await testDb
      .delete(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, created));
  }
  await releaseTestDb();
});

const walk = async (
  startAfter?: SafeId<"caseLawDecision">,
): Promise<SafeId<"caseLawDecision">[]> => {
  const visited: SafeId<"caseLawDecision">[] = [];
  let after = startAfter;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await loadRequestedDocuments(
      after === undefined
        ? { scopedDb, sourceId, limit: PAGE_LIMIT }
        : { scopedDb, sourceId, limit: PAGE_LIMIT, after },
    );
    for (const row of rows) {
      visited.push(row.id);
    }
    if (rows.length < PAGE_LIMIT) {
      return visited;
    }
    const last = rows.at(-1);
    if (!last) {
      return visited;
    }
    after = last.id;
  }
  throw new Error(
    `the requested tier did not drain within ${MAX_PAGES} pages; the cursor is stalling`,
  );
};

test("INVARIANT: paging the requested tier visits every decision exactly once", async () => {
  const expected = (
    await testDb
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, created))
      .orderBy(caseLawDecisions.documentFetchRequestedAt, caseLawDecisions.id)
  ).map(({ id }) => id);
  expect(expected).toHaveLength(REQUESTED_AT.length);

  const visited = await walk();

  // No microsecond twin re-emitted at a page boundary, none skipped.
  expect(visited).toEqual(expected);
  expect(new Set(visited).size).toBe(expected.length);
});

test("the fixture reproduces the boundary a millisecond cursor cannot pass", async () => {
  // Guards the file against going vacuous: seeded from a JS `Date` these
  // rows could not reproduce the bug. Every one must differ from its own
  // millisecond truncation, and a truncated ascending boundary must still
  // admit the very row it was cut at — which is the stall.
  const ordered = await walk();
  const boundary = ordered.at(4);
  expect(boundary).toBeDefined();
  if (boundary === undefined) {
    return;
  }

  const [counts] = await testDb
    .select({
      microsecondRows: sql<number>`count(*) FILTER (
        WHERE ${caseLawDecisions.documentFetchRequestedAt}
          <> date_trunc('milliseconds', ${caseLawDecisions.documentFetchRequestedAt})
      )::int`,
      // Rows a truncated `>` boundary would still return, the boundary row
      // among them: that repetition is what never lets the queue advance.
      readmittedBoundaryRows: sql<number>`count(*) FILTER (
        WHERE ${caseLawDecisions.id} = ${boundary}
          AND ${caseLawDecisions.documentFetchRequestedAt} > date_trunc(
            'milliseconds',
            (SELECT b.document_fetch_requested_at
             FROM case_law_decisions b WHERE b.id = ${boundary})
          )
      )::int`,
    })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, created));

  expect(counts).toBeDefined();
  expect(counts?.microsecondRows).toBe(REQUESTED_AT.length);
  expect(counts?.readmittedBoundaryRows).toBe(1);
});

test("INVARIANT: resuming after any decision yields exactly the ones that follow", async () => {
  const expected = await walk();

  for (const [index, boundary] of expected.entries()) {
    const remainder = await walk(boundary);
    expect(remainder).toEqual(expected.slice(index + 1));
  }
});
