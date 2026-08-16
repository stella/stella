/**
 * The repair behind a census drift warning: clear the index marks for a
 * jurisdiction so the ordinary backfill re-selects it.
 *
 * Three things can go wrong, and all of them are SQL. It can clear more
 * than the operator asked for, which hands the backfill a backlog that
 * starves every newly ingested decision behind it. It can clear rows in
 * a jurisdiction that was not short. And it can clear the same page on
 * every run, so an operator re-running it to walk a large jurisdiction
 * never gets past the first slice — which reads as the repair working,
 * because rows are reported cleared every time.
 */

import { beforeAll, expect, test } from "bun:test";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { clearJurisdictionIndexMarks } from "@/api/lib/corpus-index/census";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v2";
const SHORT_JURISDICTION = "SVK";
const HEALTHY_JURISDICTION = "CZE";
const DECISIONS_PER_JURISDICTION = 6;
const SLICE = 4;

const sourceId = toSafeId<"caseLawSource">(
  "00000000-0000-4000-8000-0000000000a1",
);

/** Ordered ids, so the slice boundary is predictable. */
const decisionId = (jurisdiction: string, index: number) =>
  toSafeId<"caseLawDecision">(
    `00000000-0000-4000-8000-${jurisdiction === SHORT_JURISDICTION ? "1" : "2"}00000000${String(index).padStart(3, "0")}`,
  );

let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const markedRows = async (jurisdiction: string) =>
  await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.country, jurisdiction),
        isNotNull(caseLawDecisions.indexedHash),
      ),
    );

const enqueuedProjections = async () =>
  await db
    .select({ id: caseLawCorpusIndexProjections.decisionId })
    .from(caseLawCorpusIndexProjections)
    .where(eq(caseLawCorpusIndexProjections.pendingAction, "index"));

/**
 * The projection trigger is what turns a cleared mark into queued work,
 * so the repair is only meaningful with it installed. The test snapshot
 * carries the tables but not this migration's functions, so it is
 * applied here rather than asserted around.
 */
const installProjectionTrigger = async (): Promise<void> => {
  const migration = await Bun.file(
    new URL(
      "../../../drizzle/20260731170000_case_law_corpus_generation_backfill/migration.sql",
      import.meta.url,
    ),
  ).text();
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) =>
      statement.includes("enqueue_case_law_corpus_index_projection"),
    );
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    // oxlint-disable-next-line no-await-in-loop -- function then trigger; order-dependent DDL
    await db.execute(sql.raw(statement));
  }
};

beforeAll(async () => {
  const client = await createTestPglite();
  db = drizzle({ client });
  const handle = async (callback: (tx: Transaction) => Promise<unknown>) =>
    // SAFETY: pglite's drizzle instance satisfies the transaction surface
    // this repair uses (`execute` only).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded test database stands in for the scoped handle
    await callback(db as unknown as Transaction);
  // SAFETY: brand-only wrapper; the repair never inspects the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  scopedDb = handle as unknown as ScopedDb;

  await db
    .insert(caseLawSources)
    .values([{ adapterKey: "public", id: sourceId, name: "public" }]);
  await db
    .insert(caseLawCorpusIndexBackfills)
    .values([{ generation: GENERATION }]);

  const decisions: (typeof caseLawDecisions.$inferInsert)[] = [];
  const projections: (typeof caseLawCorpusIndexProjections.$inferInsert)[] = [];
  for (const jurisdiction of [SHORT_JURISDICTION, HEALTHY_JURISDICTION]) {
    for (let index = 0; index < DECISIONS_PER_JURISDICTION; index += 1) {
      const id = decisionId(jurisdiction, index);
      decisions.push({
        caseNumber: `${jurisdiction}-${index}`,
        contentHash: `hash-${jurisdiction}-${index}`,
        country: jurisdiction,
        court: "Test court",
        id,
        indexedHash: `hash-${jurisdiction}-${index}`,
        language: "sk",
        sourceId,
      });
      projections.push({
        decisionId: id,
        generation: GENERATION,
        indexId: corpusIndexId(GENERATION, jurisdiction),
        indexedHash: `hash-${jurisdiction}-${index}`,
      });
    }
  }
  await db.insert(caseLawDecisions).values(decisions);
  await db.insert(caseLawCorpusIndexProjections).values(projections);
  await installProjectionTrigger();
});

test("the repair clears one bounded slice and leaves other jurisdictions alone", async () => {
  const cleared = await clearJurisdictionIndexMarks({
    scopedDb,
    jurisdiction: SHORT_JURISDICTION,
    limit: SLICE,
  });

  expect(cleared).toBe(SLICE);
  expect(await markedRows(SHORT_JURISDICTION)).toHaveLength(
    DECISIONS_PER_JURISDICTION - SLICE,
  );
  expect(await markedRows(HEALTHY_JURISDICTION)).toHaveLength(
    DECISIONS_PER_JURISDICTION,
  );
  // The point of writing only this column: the projection trigger turns
  // the cleared mark into a queued re-index, so the repair reaches the
  // live drain without a second, hand-maintained copy of what the
  // trigger already states.
  expect(await enqueuedProjections()).toHaveLength(SLICE);
});

test("re-running walks the jurisdiction instead of re-clearing the first page", async () => {
  const cleared = await clearJurisdictionIndexMarks({
    scopedDb,
    jurisdiction: SHORT_JURISDICTION,
    limit: SLICE,
  });

  // The remainder, not the slice: a repair that always reported `limit`
  // rows cleared would look identical while making no progress.
  expect(cleared).toBe(DECISIONS_PER_JURISDICTION - SLICE);
  expect(await markedRows(SHORT_JURISDICTION)).toHaveLength(0);

  const exhausted = await clearJurisdictionIndexMarks({
    scopedDb,
    jurisdiction: SHORT_JURISDICTION,
    limit: SLICE,
  });
  expect(exhausted).toBe(0);
});

test("the untouched jurisdiction kept every mark", async () => {
  const remaining: SafeId<"caseLawDecision">[] = (
    await markedRows(HEALTHY_JURISDICTION)
  ).map(({ id }) => id);

  expect(remaining).toHaveLength(DECISIONS_PER_JURISDICTION);
});
