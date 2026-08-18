/**
 * The repair behind a census drift warning: un-mark an index so the
 * ordinary backfill re-selects it. Up to generation 2 every index is one
 * jurisdiction's, so the two are named interchangeably below; from
 * generation 3 on an index may hold several, and the repair has to reach
 * all of them and no other index's.
 *
 * Five things can go wrong, and all of them are SQL. It can miss the
 * rows the census counted — a generation rebuild records success in the
 * projection and leaves the legacy column alone, so a repair keyed off
 * that column is inert for exactly the rows a rebuild lost. It can clear
 * more than the operator asked for, handing the backfill a backlog that
 * starves every newly ingested decision behind it. It can reach into a
 * jurisdiction that was not short. It can clear the same page every
 * run, so an operator re-running it to walk a large jurisdiction never
 * gets past the first slice — which reads as the repair working, because
 * rows are reported cleared every time. And on a shared index it can
 * address one member's rows and leave the others marked.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
import {
  clearIndexMarks,
  MAX_REPAIR_SLICE,
} from "@/api/lib/corpus-index/census";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { installCaseLawProjectionTrigger } from "@/api/tests/helpers/case-law-projection-trigger";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v2";
/** Marked through the generation projection, as a rebuild leaves them. */
const SHORT_JURISDICTION = "SVK";
/** Marked through the legacy column, as the incremental path leaves them. */
const HEALTHY_JURISDICTION = "POL";
const DECISIONS_PER_JURISDICTION = 6;
const SLICE = 4;

/** From generation 3 on these two share one physical index. */
const GROUPED_GENERATION = "case_law_v3";
const GROUPED_JURISDICTIONS = ["CZE", "SVK"] as const;
const DECISIONS_PER_GROUPED_JURISDICTION = 3;

const sourceId = toSafeId<"caseLawSource">(
  "00000000-0000-4000-8000-0000000000a1",
);

/** Ids ordered by fixture then jurisdiction, so a slice boundary is predictable. */
const ID_PREFIX = {
  [SHORT_JURISDICTION]: "1",
  [HEALTHY_JURISDICTION]: "2",
  [`${GROUPED_GENERATION}:CZE`]: "3",
  [`${GROUPED_GENERATION}:SVK`]: "4",
} as const;

const decisionId = (fixture: keyof typeof ID_PREFIX, index: number) =>
  toSafeId<"caseLawDecision">(
    `00000000-0000-4000-8000-${ID_PREFIX[fixture]}00000000${String(index).padStart(3, "0")}`,
  );

let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

/**
 * Rows the census would count for this jurisdiction under this generation
 * — the same predicate the repair slices on, so the test measures what
 * the alert measures.
 */
const currentRows = async (
  jurisdiction: string,
  generation: string = GENERATION,
) =>
  await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .leftJoin(
      caseLawCorpusIndexProjections,
      caseLawCorpusProjectionJoin(generation),
    )
    .where(
      and(
        eq(caseLawDecisions.country, jurisdiction),
        currentCaseLawCorpusProjection(generation),
      ),
    );

const enqueuedProjections = async () =>
  await db
    .select({ id: caseLawCorpusIndexProjections.decisionId })
    .from(caseLawCorpusIndexProjections)
    .where(eq(caseLawCorpusIndexProjections.pendingAction, "index"));

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
  for (const jurisdiction of [
    SHORT_JURISDICTION,
    HEALTHY_JURISDICTION,
  ] as const) {
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
  // The projection trigger is what turns a cleared mark into queued work,
  // so the repair is only meaningful with it installed. The test snapshot
  // carries the tables but not the migrations' functions.
  await installCaseLawProjectionTrigger(db);
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

describe("an index shared by several jurisdictions", () => {
  const sharedIndexId = corpusIndexId(GROUPED_GENERATION, "CZE");

  /** Current row counts under the grouped generation, per jurisdiction. */
  const currentRowsOfEach = async (jurisdictions: readonly string[]) =>
    await Promise.all(
      jurisdictions.map(
        async (jurisdiction) =>
          (await currentRows(jurisdiction, GROUPED_GENERATION)).length,
      ),
    );

  beforeAll(async () => {
    const decisions: (typeof caseLawDecisions.$inferInsert)[] = [];
    const projections: (typeof caseLawCorpusIndexProjections.$inferInsert)[] =
      [];
    for (const jurisdiction of GROUPED_JURISDICTIONS) {
      expect(corpusIndexId(GROUPED_GENERATION, jurisdiction)).toBe(
        sharedIndexId,
      );
      for (
        let index = 0;
        index < DECISIONS_PER_GROUPED_JURISDICTION;
        index += 1
      ) {
        const id = decisionId(`${GROUPED_GENERATION}:${jurisdiction}`, index);
        const contentHash = `hash-${GROUPED_GENERATION}-${jurisdiction}-${index}`;
        decisions.push({
          caseNumber: `${GROUPED_GENERATION}-${jurisdiction}-${index}`,
          contentHash,
          country: jurisdiction,
          court: "Test court",
          id,
          indexedHash: null,
          language: "cs",
          sourceId,
        });
        projections.push({
          decisionId: id,
          generation: GROUPED_GENERATION,
          indexId: sharedIndexId,
          indexedHash: contentHash,
        });
      }
    }
    // The decisions land before the generation is registered, so the
    // installed trigger queues them for the earlier generation only; the
    // grouped generation then marks them through the projection alone, as
    // a rebuild leaves them.
    await db.insert(caseLawDecisions).values(decisions);
    await db
      .insert(caseLawCorpusIndexBackfills)
      .values([{ generation: GROUPED_GENERATION }]);
    await db.insert(caseLawCorpusIndexProjections).values(projections);
  });

  test("one repair reaches every jurisdiction the index holds and no other index", async () => {
    // Every member's rows are current, and so are the legacy-marked rows of
    // a jurisdiction whose index is its own; the earlier repairs left the
    // rebuilt generation-2 rows out of every generation.
    expect(await currentRowsOfEach(GROUPED_JURISDICTIONS)).toEqual([
      DECISIONS_PER_GROUPED_JURISDICTION,
      DECISIONS_PER_GROUPED_JURISDICTION,
    ]);
    expect(
      await currentRows(HEALTHY_JURISDICTION, GROUPED_GENERATION),
    ).toHaveLength(DECISIONS_PER_JURISDICTION);
    // The index the healthy rows derive to is another one; the repair below
    // must not reach it.
    expect(corpusIndexId(GROUPED_GENERATION, HEALTHY_JURISDICTION)).not.toBe(
      sharedIndexId,
    );

    const cleared = await clearIndexMarks({
      scopedDb,
      generation: GROUPED_GENERATION,
      indexId: sharedIndexId,
      limit: MAX_REPAIR_SLICE,
    });

    // Both members, in one repair: a repair addressing the rows by one
    // member's country would leave the other's marked.
    expect(cleared).toBe(
      GROUPED_JURISDICTIONS.length * DECISIONS_PER_GROUPED_JURISDICTION,
    );
    expect(await currentRowsOfEach(GROUPED_JURISDICTIONS)).toEqual([0, 0]);
    expect(
      await currentRows(HEALTHY_JURISDICTION, GROUPED_GENERATION),
    ).toHaveLength(DECISIONS_PER_JURISDICTION);
  });
});
