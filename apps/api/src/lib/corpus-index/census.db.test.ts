/**
 * The repair behind a census drift warning: un-mark an index so the
 * ordinary backfill re-selects it. Under this generation every index is
 * one jurisdiction's, so the two are named interchangeably below.
 *
 * Four things can go wrong, and all of them are SQL. It can miss the
 * rows the census counted — a generation rebuild records success in the
 * projection and leaves the legacy column alone, so a repair keyed off
 * that column is inert for exactly the rows a rebuild lost. It can clear
 * more than the operator asked for, handing the backfill a backlog that
 * starves every newly ingested decision behind it. It can reach into a
 * jurisdiction that was not short. And it can clear the same page every
 * run, so an operator re-running it to walk a large jurisdiction never
 * gets past the first slice — which reads as the repair working, because
 * rows are reported cleared every time.
 */

import { beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
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
import { clearIndexMarks } from "@/api/lib/corpus-index/census";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v2";
/** Marked through the generation projection, as a rebuild leaves them. */
const SHORT_JURISDICTION = "SVK";
/** Marked through the legacy column, as the incremental path leaves them. */
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

/**
 * Rows the census would count for this jurisdiction — the same predicate
 * the repair slices on, so the test measures what the alert measures.
 */
const currentRows = async (jurisdiction: string) =>
  await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .leftJoin(
      caseLawCorpusIndexProjections,
      caseLawCorpusProjectionJoin(GENERATION),
    )
    .where(
      and(
        eq(caseLawDecisions.country, jurisdiction),
        currentCaseLawCorpusProjection(GENERATION),
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
    const rebuilt = jurisdiction === SHORT_JURISDICTION;
    for (let index = 0; index < DECISIONS_PER_JURISDICTION; index += 1) {
      const id = decisionId(jurisdiction, index);
      const contentHash = `hash-${jurisdiction}-${index}`;
      decisions.push({
        caseNumber: `${jurisdiction}-${index}`,
        contentHash,
        country: jurisdiction,
        court: "Test court",
        id,
        // A rebuild marks the projection and leaves this null; the
        // incremental path is the other way round. Both read as indexed.
        indexedHash: rebuilt ? null : contentHash,
        language: "sk",
        sourceId,
      });
      if (rebuilt) {
        projections.push({
          decisionId: id,
          generation: GENERATION,
          indexId: corpusIndexId(GENERATION, jurisdiction),
          indexedHash: contentHash,
        });
      }
    }
  }
  await db.insert(caseLawDecisions).values(decisions);
  await db.insert(caseLawCorpusIndexProjections).values(projections);
  await installProjectionTrigger();
});

test("the repair reaches rows marked only through the generation projection", async () => {
  // The case a repair keyed off `case_law_decisions.indexed_hash` would
  // miss entirely: these rows never had one.
  expect(await currentRows(SHORT_JURISDICTION)).toHaveLength(
    DECISIONS_PER_JURISDICTION,
  );

  const cleared = await clearIndexMarks({
    scopedDb,
    generation: GENERATION,
    indexId: corpusIndexId(GENERATION, SHORT_JURISDICTION),
    limit: SLICE,
  });

  expect(cleared).toBe(SLICE);
  expect(await currentRows(SHORT_JURISDICTION)).toHaveLength(
    DECISIONS_PER_JURISDICTION - SLICE,
  );
  // Writing only that one column is the point: the projection trigger
  // turns the assignment into queued work, so the repair reaches the
  // live drain without a second, hand-maintained copy of what the
  // trigger already states.
  expect(await enqueuedProjections()).toHaveLength(SLICE);
});

test("re-running walks the jurisdiction instead of re-clearing the first page", async () => {
  const cleared = await clearIndexMarks({
    scopedDb,
    generation: GENERATION,
    indexId: corpusIndexId(GENERATION, SHORT_JURISDICTION),
    limit: SLICE,
  });

  // The remainder, not the slice: a repair that always reported `limit`
  // rows cleared would look identical while making no progress.
  expect(cleared).toBe(DECISIONS_PER_JURISDICTION - SLICE);
  expect(await currentRows(SHORT_JURISDICTION)).toHaveLength(0);

  const exhausted = await clearIndexMarks({
    scopedDb,
    generation: GENERATION,
    indexId: corpusIndexId(GENERATION, SHORT_JURISDICTION),
    limit: SLICE,
  });
  expect(exhausted).toBe(0);
});

test("the jurisdiction that was not short kept every mark", async () => {
  expect(await currentRows(HEALTHY_JURISDICTION)).toHaveLength(
    DECISIONS_PER_JURISDICTION,
  );
});
