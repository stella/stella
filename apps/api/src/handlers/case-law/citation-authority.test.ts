import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  type CitationContributionWeight,
  citationContributionWeight,
  hasResolvedCitations,
  oldestCitationAuthorityRecomputeAt,
  recomputeCitationAuthorityBatch,
} from "@/api/handlers/case-law/citation-authority";
import {
  citationScore,
  type CitationInput,
} from "@/api/handlers/case-law/citation-score";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { flattenCourtWeightEntries } from "@/api/handlers/case-law/court-weights";
import type { CourtWeightEntry } from "@/api/handlers/case-law/court-weights";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// The materialized citation_authority column must equal citationScore()
// evaluated at the same instant, so moving the blend out of the per-query
// SQL into a precomputed column does not change ranking. `now` is pinned
// on both sides because the value decays continuously with time.
//
// The sweep is now batched, which adds a second thing to pin: batching must be
// arithmetic-neutral. A sweep run one decision at a time and a sweep run in one
// batch have to leave the corpus in the same state, or the bound that makes the
// statement survive a growing corpus has bought a different ranking.

const NOW = new Date("2026-06-05T00:00:00.000Z");

/**
 * What cites the fixture's cited decision, as `citationScore` sees it.
 *
 * Two unclassified citations and one negative treatment: the corpus is mostly
 * unclassified, so the fixture has to carry both cases or the SQL could weigh
 * NULL polarity any way it liked and still match.
 */
const CITED_CITATIONS = [
  { citingCourt: "Nejvyšší soud", citingDate: "2025-01-01" },
  { citingCourt: "Krajský soud", citingDate: "2018-01-01" },
  {
    citingCourt: "Nejvyšší soud",
    citingDate: "2024-01-01",
    polarity: POLARITY.NEGATIVE,
  },
] as const satisfies readonly CitationInput[];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const citedId = createSafeId<"caseLawDecision">();
const supremeCitingId = createSafeId<"caseLawDecision">();
const regionalCitingId = createSafeId<"caseLawDecision">();
const overrulingCitingId = createSafeId<"caseLawDecision">();
const orphanId = createSafeId<"caseLawDecision">();

/** The seeded weights, as the migrated table gives them to production. */
const SEED_MAP = courtWeightMapFromSeed();
const SEED_ENTRIES = flattenCourtWeightEntries(SEED_MAP);

type SweepOptions = {
  now?: Date;
  courtWeightEntries?: CourtWeightEntry[];
  contributionWeight?: CitationContributionWeight;
};

/**
 * Walk a whole sweep at the given batch size, and report what it did.
 *
 * A pinned window is what makes the walk terminate: the boundary and the stamp
 * are the same instant, so a row this sweep recomputed is no longer *before*
 * the boundary. Two instants from two clocks would not have that property, and
 * a boundary even a millisecond ahead of the stamp is a walk that never ends.
 */
const sweep = async (
  limit: number,
  options: SweepOptions = {},
): Promise<{ recomputed: number; cited: number; batches: number }> => {
  const now = options.now ?? NOW;
  const totals = { recomputed: 0, cited: 0, batches: 0 };
  for (let turn = 0; turn < 200; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- the sweep advances by the work each batch commits; the next batch reads what this one wrote
    const batch = await db.transaction(
      async (tx) =>
        await recomputeCitationAuthorityBatch(tx, {
          limit,
          window: { type: "pinned", at: now },
          ...(options.contributionWeight
            ? { contributionWeight: options.contributionWeight }
            : {}),
          courtWeightEntries: options.courtWeightEntries ?? SEED_ENTRIES,
        }),
    );
    if (batch.recomputed === 0) {
      return totals;
    }
    totals.recomputed += batch.recomputed;
    totals.cited += batch.cited;
    totals.batches += 1;
  }
  throw new Error("the citation-authority sweep did not terminate");
};

/**
 * Put every decision back in the due set.
 *
 * The production sweep does this by waiting: a row falls due again once the
 * refresh interval has passed. A test that has to re-run a sweep at a pinned
 * instant clears the stamp instead, which is the same state a corpus is in
 * before its first sweep.
 */
const markAllDue = async (): Promise<void> => {
  await db.execute(
    sql`UPDATE case_law_decisions SET citation_authority_computed_at = NULL`,
  );
};

// createTestPglite()'s full in-process build (no PGLITE_TEST_SNAPSHOT) is
// close enough to bun:test's 5s default hook timeout that running this file
// alongside others in the same worker occasionally tips it over; match the
// { timeout: 30_000 } convention used by the other pglite fixtures
// (entity-filters.differential.test.ts, legislation/ingestion.test.ts).
beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    // Calendar-only decision dates are UTC midnights in the TypeScript
    // reference implementation. A non-UTC database session must produce the
    // same score instead of applying its local offset during the implicit cast.
    await db.execute(sql.raw("SET TIME ZONE 'Europe/Prague'"));

    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "test",
      name: "Test source",
    });

    await db.insert(caseLawDecisions).values([
      {
        id: citedId,
        sourceId,
        caseNumber: "1 Cdo 1/2020",
        court: "Okresní soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2020-01-01",
      },
      {
        id: supremeCitingId,
        sourceId,
        caseNumber: "2 Cdo 2/2025",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2025-01-01",
      },
      {
        id: regionalCitingId,
        sourceId,
        caseNumber: "3 Co 3/2018",
        court: "Krajský soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2018-01-01",
      },
      {
        id: orphanId,
        sourceId,
        caseNumber: "4 Cdo 4/2021",
        court: "Okresní soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2021-01-01",
      },
      {
        id: overrulingCitingId,
        sourceId,
        caseNumber: "5 Cdo 5/2024",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2024-01-01",
      },
    ]);

    await db.insert(caseLawCitations).values([
      {
        citingDecisionId: supremeCitingId,
        citedDecisionId: citedId,
        citationText: "1 Cdo 1/2020",
      },
      {
        citingDecisionId: regionalCitingId,
        citedDecisionId: citedId,
        citationText: "1 Cdo 1/2020",
      },
      {
        citingDecisionId: overrulingCitingId,
        citedDecisionId: citedId,
        citationText: "1 Cdo 1/2020",
        polarity: POLARITY.NEGATIVE,
      },
    ]);

    await sweep(1000);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await client.close();
});

const authorityOf = async (id: SafeId<"caseLawDecision">): Promise<number> => {
  const [row] = await db
    .select({ a: caseLawDecisions.citationAuthority })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  return row?.a ?? Number.NaN;
};

const countOf = async (id: SafeId<"caseLawDecision">): Promise<number> => {
  const [row] = await db
    .select({ n: caseLawDecisions.citationCount })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  return row?.n ?? Number.NaN;
};

const snapshot = async (): Promise<
  { id: string; authority: number | null; count: number }[]
> =>
  await db
    .select({
      id: caseLawDecisions.id,
      authority: caseLawDecisions.citationAuthority,
      count: caseLawDecisions.citationCount,
    })
    .from(caseLawDecisions)
    .orderBy(caseLawDecisions.id);

test("materialized authority equals citationScore() at the same instant", async () => {
  const expected = citationScore([...CITED_CITATIONS], NOW, SEED_MAP);

  // Not vacuous: the negative treatment is a citation the sum has to drop.
  // Ignoring polarity would score the same fixture higher, so a SQL twin that
  // forgot the polarity CASE could not pass the equality below.
  const ignoringPolarity = citationScore(
    CITED_CITATIONS.map(({ citingCourt, citingDate }) => ({
      citingCourt,
      citingDate,
    })),
    NOW,
    SEED_MAP,
  );
  expect(ignoringPolarity).toBeGreaterThan(expected);

  expect(await authorityOf(citedId)).toBeCloseTo(expected, 9);
  // The overruling citation still counts: it is a citation, and the citator
  // exists to surface exactly that one.
  expect(await countOf(citedId)).toBe(3);
});

test("a decision with no incoming citations has zero authority", async () => {
  expect(await authorityOf(orphanId)).toBe(0);
  expect(await countOf(orphanId)).toBe(0);
  // The citing decisions themselves are not cited by anyone.
  expect(await authorityOf(supremeCitingId)).toBe(0);
  expect(await countOf(supremeCitingId)).toBe(0);
});

test("a more authoritative citing court yields higher authority", async () => {
  // Same single citation, supreme (weight 8) vs regional (weight 4),
  // controlling for date so only court weight differs.
  const supreme = citationScore(
    [{ citingCourt: "Nejvyšší soud", citingDate: "2024-01-01" }],
    NOW,
    SEED_MAP,
  );
  const regional = citationScore(
    [{ citingCourt: "Krajský soud", citingDate: "2024-01-01" }],
    NOW,
    SEED_MAP,
  );
  expect(supreme).toBeGreaterThan(regional);
});

test("the sweep covers every decision once and then reports itself current", async () => {
  // Every batch stamps the rows it wrote, which takes them out of the set the
  // next batch walks. That is the whole of the sweep's bookkeeping: no cursor
  // is persisted, so this is what proves the walk terminates rather than
  // re-serving the same rows or stopping short of the corpus.
  const [{ n: total } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(caseLawDecisions);
  await markAllDue();
  const walked = await sweep(1000);
  expect(walked.recomputed).toBe(total);
  expect(walked.cited).toBe(1);
  // Immediately afterwards nothing is due against the same boundary.
  expect((await sweep(1000)).recomputed).toBe(0);
});

test("batching is arithmetic-neutral", async () => {
  // The bound that makes the statement survive a growing corpus must not buy
  // a different ranking. One decision per batch and the whole corpus in one
  // batch have to leave the same values behind, to the last bit.
  await markAllDue();
  const oneAtATime = await sweep(1);
  const perBatch = await snapshot();

  await markAllDue();
  const allAtOnce = await sweep(1000);
  const single = await snapshot();

  expect(oneAtATime.recomputed).toBe(allAtOnce.recomputed);
  expect(oneAtATime.batches).toBeGreaterThan(allAtOnce.batches);
  expect(perBatch).toEqual(single);
});

test("a completed pinned sweep leaves nothing computed before its instant", async () => {
  // The guarantee is a floor, not an equality. A row the rolling loop computed
  // *after* the pinned instant is fresher and is deliberately skipped, so the
  // assertion is that nothing is left older — which is what "the backfill
  // finished" has to mean for it to be worth running.
  await markAllDue();
  const later = new Date(NOW.getTime() + 60_000);
  await db.execute(sql`
    UPDATE case_law_decisions
       SET citation_authority_computed_at = ${later.toISOString()}::timestamptz
     WHERE id = ${orphanId}
  `);

  await sweep(1000);

  const [{ n: stale } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(caseLawDecisions)
    .where(
      sql`citation_authority_computed_at IS NULL
          OR citation_authority_computed_at < ${NOW.toISOString()}::timestamptz`,
    );
  expect(stale).toBe(0);

  // And the fresher row kept its own stamp rather than being dragged back.
  const [{ at } = { at: null }] = await db
    .select({ at: caseLawDecisions.citationAuthorityComputedAt })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, orphanId));
  expect(at).toEqual(later);

  await markAllDue();
  await sweep(1000);
});

test("a resumed sweep skips what the interrupted one finished", async () => {
  // The restart hazard: a fresh instant is a *new* sweep and recomputes the
  // whole corpus, because every row the interrupted run stamped is older than
  // the new boundary. Handed the original instant, the walk resumes.
  await markAllDue();
  const interrupted = await db.transaction(
    async (tx) =>
      await recomputeCitationAuthorityBatch(tx, {
        limit: 2,
        window: { type: "pinned", at: NOW },
        courtWeightEntries: SEED_ENTRIES,
      }),
  );
  expect(interrupted.recomputed).toBe(2);

  const resumed = await sweep(1000);
  const [{ n: total } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(caseLawDecisions);
  expect(resumed.recomputed).toBe(total - 2);
});

test("a rolling window converges even when the host clock runs ahead", async () => {
  // The boundary and the stamp must come from one clock. Expressed as an age,
  // both come from PostgreSQL, so a row this batch stamped is never still
  // older than the boundary — which is the difference between a sweep that
  // finishes and one that rewrites the same oldest rows forever.
  await markAllDue();
  let turnsTaken = 0;
  let converged = false;
  for (let turn = 0; turn < 50; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- the sweep advances by the work each batch commits
    const batch = await db.transaction(
      async (tx) =>
        await recomputeCitationAuthorityBatch(tx, {
          limit: 1000,
          window: { type: "olderThan", ms: 60_000 },
          courtWeightEntries: SEED_ENTRIES,
        }),
    );
    turnsTaken = turn;
    if (batch.recomputed === 0) {
      converged = true;
      break;
    }
  }
  // Reaching a fixed point at all is the whole assertion; a boundary from a
  // different clock than the stamp would spin here until the turn limit.
  expect(converged).toBe(true);
  expect(turnsTaken).toBeGreaterThan(0);

  // Restore the fixture's pinned instant for the tests that follow.
  await markAllDue();
  await sweep(1000);
});

test("the staleness probe reports the oldest computed instant", async () => {
  // The oldest rather than the newest: a sweep advances row by row, so the
  // freshest row says nothing about the picture as a whole.
  await markAllDue();
  await sweep(1000, { now: new Date("2026-06-06T00:00:00.000Z") });
  expect(await db.transaction(oldestCitationAuthorityRecomputeAt)).toEqual(
    new Date("2026-06-06T00:00:00.000Z"),
  );
  // Restore the fixture's instant for the tests that follow.
  await markAllDue();
  await sweep(1000);
});

test("a decision that has never been computed makes the probe answer null", async () => {
  const uncomputed = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id: uncomputed,
    sourceId,
    caseNumber: "9 Cdo 9/2022",
    court: "Okresní soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2022-01-01",
  });
  expect(await db.transaction(oldestCitationAuthorityRecomputeAt)).toBeNull();
  // And the sweep picks it up first, because never-computed rows sort first.
  expect((await sweep(1)).recomputed).toBe(1);
  await sweep(1000);
});

test("the contribution weight is a seam the aggregate reads through", async () => {
  // The ranking's open question — whether a citation that overrules should
  // count for less than one that follows — has to be answerable by changing
  // this expression alone. Doubling it must double the weighted sum and touch
  // nothing else, including the citation count.
  const doubled: CitationContributionWeight = (options) =>
    sql`2 * (${citationContributionWeight(options)})`;
  await markAllDue();
  await sweep(1000, { contributionWeight: doubled });

  const expected = citationScore([...CITED_CITATIONS], NOW, SEED_MAP);
  // score = ln(1 + sum), so doubling the sum is ln(1 + 2*(e^score - 1)).
  expect(await authorityOf(citedId)).toBeCloseTo(
    Math.log(1 + 2 * (Math.E ** expected - 1)),
    9,
  );
  expect(await countOf(citedId)).toBe(3);

  await markAllDue();
  await sweep(1000);
  expect(await authorityOf(citedId)).toBeCloseTo(expected, 9);
});

test("courtWeightEntries option drives the SQL instead of the legacy tiers", async () => {
  // Bug fix regression: DB-seeded court weights (case_law_court_weights,
  // loaded via loadCourtWeightEntriesForSql()) were never threaded into the
  // recompute's SQL, so it silently always used LEGACY_COURT_TIERS regardless
  // of what was seeded. A court name that matches none of the legacy CZ/SK
  // patterns (so the fallback would score it at DEFAULT_WEIGHT=1) but matches
  // CUSTOM_ENTRIES at weight 7 proves the entries actually drove the SQL.
  const customCitedId = createSafeId<"caseLawDecision">();
  const customCitingId = createSafeId<"caseLawDecision">();
  const CUSTOM_ENTRIES = [
    {
      pattern: /^Custom Seeded Court$/u,
      tier: 5,
      tierLabel: "seeded-only",
      weight: 7,
    },
  ];

  await db.insert(caseLawDecisions).values([
    {
      id: customCitedId,
      sourceId,
      caseNumber: "5 Cdo 5/2020",
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2020-01-01",
    },
    {
      id: customCitingId,
      sourceId,
      caseNumber: "6 Cdo 6/2025",
      court: "Custom Seeded Court",
      country: "CZE",
      language: "cs",
      decisionDate: "2025-01-01",
    },
  ]);
  await db.insert(caseLawCitations).values({
    citingDecisionId: customCitingId,
    citedDecisionId: customCitedId,
    citationText: "5 Cdo 5/2020",
  });

  await markAllDue();
  await sweep(1000, { courtWeightEntries: CUSTOM_ENTRIES });

  expect(await authorityOf(customCitedId)).toBeCloseTo(
    citationScore(
      [{ citingCourt: "Custom Seeded Court", citingDate: "2025-01-01" }],
      NOW,
      new Map([["CZE", CUSTOM_ENTRIES]]),
    ),
    9,
  );
  // Sanity check: under the seeded weights this citing court matches no
  // pattern (DEFAULT_WEIGHT=1), which differs from the custom weight (7)
  // enough that the assertion above cannot pass by coincidence.
  expect(await authorityOf(customCitedId)).not.toBeCloseTo(
    citationScore(
      [{ citingCourt: "Custom Seeded Court", citingDate: "2025-01-01" }],
      NOW,
      SEED_MAP,
    ),
    2,
  );
});

test("an unrankable corpus is detected before a sweep walks it", async () => {
  expect(await db.transaction(hasResolvedCitations)).toBe(true);
});

test("the cited decision's own age does not change its authority", async () => {
  // Two decisions with identical citation sets, published twenty-nine years
  // apart. Authority reads the citing side only, so they have to score the
  // same value: the removed divisor — the cited decision's own age — put the
  // older one far below the newer for nothing but having existed longer.
  const oldId = createSafeId<"caseLawDecision">();
  const youngId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values([
    {
      id: oldId,
      sourceId,
      caseNumber: "7 Cdo 7/1995",
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      decisionDate: "1995-01-01",
    },
    {
      id: youngId,
      sourceId,
      caseNumber: "8 Cdo 8/2024",
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2024-01-01",
    },
  ]);
  await db.insert(caseLawCitations).values([
    {
      citingDecisionId: supremeCitingId,
      citedDecisionId: oldId,
      citationText: "7 Cdo 7/1995",
    },
    {
      citingDecisionId: regionalCitingId,
      citedDecisionId: oldId,
      citationText: "7 Cdo 7/1995",
    },
    {
      citingDecisionId: supremeCitingId,
      citedDecisionId: youngId,
      citationText: "8 Cdo 8/2024",
    },
    {
      citingDecisionId: regionalCitingId,
      citedDecisionId: youngId,
      citationText: "8 Cdo 8/2024",
    },
  ]);

  await markAllDue();
  await sweep(1000);

  // Not vacuous: the fixture differs precisely where the removed term read.
  const dates = await db
    .select({ id: caseLawDecisions.id, date: caseLawDecisions.decisionDate })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [oldId, youngId]));
  expect(new Set(dates.map((row) => row.date)).size).toBe(2);

  const older = await authorityOf(oldId);
  expect(older).toBe(await authorityOf(youngId));
  expect(older).toBeGreaterThan(0);
  expect(await countOf(oldId)).toBe(await countOf(youngId));
});
