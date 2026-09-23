import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  CITATION_AUTHORITY_WRITE_TOLERANCE,
  type CitationContributionWeight,
  citationContributionWeight,
  hasResolvedCitations,
  recomputeCitationAuthorityBatch,
  tryAdvanceCitationAuthoritySweep,
} from "@/api/handlers/case-law/citation-authority";
import {
  citationScore,
  type CitationInput,
} from "@/api/handlers/case-law/citation-score";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { flattenCourtWeightEntries } from "@/api/lib/case-law/court-weights";
import type { CourtWeightEntry } from "@/api/lib/case-law/court-weights";
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

type SweepTotals = {
  scanned: number;
  written: number;
  cited: number;
  batches: number;
};

/**
 * Walk one whole pass at the given batch size, and report what it did. Each
 * batch starts where the last one stopped; a short batch ends the pass.
 */
const sweep = async (
  limit: number,
  options: SweepOptions = {},
): Promise<SweepTotals> => {
  const now = options.now ?? NOW;
  const totals = { scanned: 0, written: 0, cited: 0, batches: 0 };
  let after: string | null = null;
  for (let turn = 0; turn < 200; turn += 1) {
    const position = after;
    const batch = await db.transaction(
      async (tx) =>
        await recomputeCitationAuthorityBatch(tx, {
          after: position,
          limit,
          now: { type: "pinned", at: now },
          ...(options.contributionWeight
            ? { contributionWeight: options.contributionWeight }
            : {}),
          courtWeightEntries: options.courtWeightEntries ?? SEED_ENTRIES,
        }),
    );
    totals.scanned += batch.scanned;
    totals.written += batch.written;
    totals.cited += batch.cited;
    totals.batches += 1;
    after = batch.lastId;
    if (batch.scanned < limit) {
      return totals;
    }
  }
  throw new Error("the citation-authority sweep did not terminate");
};

/**
 * Put every decision back to the never-computed defaults, so the next pass
 * has to write all of them.
 */
const resetAuthority = async (): Promise<void> => {
  await db.execute(
    sql`UPDATE case_law_decisions SET citation_authority = 0, citation_count = 0`,
  );
};

/** Every decision tuple's header: `xmax` is where an update or lock lands. */
const tupleHeaders = async (): Promise<unknown> =>
  await db.execute(sql`
    SELECT id::text AS id, xmin::text AS xmin, xmax::text AS xmax
      FROM case_law_decisions
     ORDER BY id
  `);

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

test("a listing-only citing decision weighs on nothing", async () => {
  // A row the corpus does not publish must not raise a published decision's
  // count or its rank. The live scorer in the search lateral and this
  // materialized column read the same citing side, so they gate it alike.
  const before = await countOf(citedId);
  const beforeAuthority = await authorityOf(citedId);
  expect(before).toBeGreaterThan(0);

  await db
    .update(caseLawDecisions)
    .set({
      metadata: { _stellaPartialObservation: { isListingOnly: true } },
    })
    .where(eq(caseLawDecisions.id, supremeCitingId));
  await sweep(1000);

  expect(await countOf(citedId)).toBe(before - 1);
  expect(await authorityOf(citedId)).toBeLessThan(beforeAuthority);

  // And it weighs again the moment its detail arrives.
  await db
    .update(caseLawDecisions)
    .set({ metadata: {} })
    .where(eq(caseLawDecisions.id, supremeCitingId));
  await sweep(1000);

  expect(await countOf(citedId)).toBe(before);
  expect(await authorityOf(citedId)).toBeCloseTo(beforeAuthority, 9);
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

test("a pass examines every decision once", async () => {
  const [{ n: total } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(caseLawDecisions);
  const walked = await sweep(2);
  expect(walked.scanned).toBe(total);
  expect(walked.cited).toBe(1);
  // Not vacuous: the pass took several batches, so the keyset resumed.
  expect(walked.batches).toBeGreaterThan(1);
});

test("a pass over an unchanged graph writes no tuple", async () => {
  // A decision nobody cites holds the zeroes a recompute would write, and a
  // cited one only drifts by its decay. Rewriting either says nothing new and
  // still writes a tuple and every index entry on it, on every pass.
  const before = await tupleHeaders();
  const again = await sweep(1000);
  expect(again.written).toBe(0);
  expect(await tupleHeaders()).toEqual(before);

  // Decay inside the tolerance is not a change worth a write either.
  const halfADayLater = new Date(NOW.getTime() + 43_200_000);
  const drifted = await sweep(1000, { now: halfADayLater });
  expect(drifted.written).toBe(0);
  expect(await tupleHeaders()).toEqual(before);
  // Not vacuous: the value did move, by less than the tolerance.
  const exactLater = citationScore(
    [...CITED_CITATIONS],
    halfADayLater,
    SEED_MAP,
  );
  const stored = await authorityOf(citedId);
  expect(exactLater).not.toBe(stored);
  expect(Math.abs(exactLater - stored)).toBeLessThanOrEqual(
    CITATION_AUTHORITY_WRITE_TOLERANCE,
  );

  // Decay beyond it is written, to the exact value at that instant.
  const yearsLater = new Date("2036-06-05T00:00:00.000Z");
  const decayed = await sweep(1000, { now: yearsLater });
  expect(decayed.written).toBe(1);
  expect(await authorityOf(citedId)).toBeCloseTo(
    citationScore([...CITED_CITATIONS], yearsLater, SEED_MAP),
    9,
  );

  // Restore the fixture's instant for the tests that follow.
  await sweep(1000);
  expect(await authorityOf(citedId)).toBeCloseTo(
    citationScore([...CITED_CITATIONS], NOW, SEED_MAP),
    9,
  );
});

test("batching is arithmetic-neutral", async () => {
  // The bound that makes the statement survive a growing corpus must not buy
  // a different ranking. One decision per batch and the whole corpus in one
  // batch have to leave the same values behind, to the last bit.
  await resetAuthority();
  const oneAtATime = await sweep(1);
  const perBatch = await snapshot();

  await resetAuthority();
  const allAtOnce = await sweep(1000);
  const single = await snapshot();

  expect(oneAtATime.written).toBe(allAtOnce.written);
  expect(oneAtATime.written).toBeGreaterThan(0);
  expect(oneAtATime.batches).toBeGreaterThan(allAtOnce.batches);
  expect(perBatch).toEqual(single);
});

test("the continuous sweep resumes its pass and rests between passes", async () => {
  await db.execute(sql`DELETE FROM case_law_citation_authority_sweep`);
  const [{ n: total } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(caseLawDecisions);
  const step = async (intervalMs: number) =>
    await db.transaction(
      async (tx) =>
        await tryAdvanceCitationAuthoritySweep(tx, {
          limit: 2,
          intervalMs,
          courtWeightEntries: SEED_ENTRIES,
        }),
    );
  const hour = 3_600_000;

  // One pass, a batch per step, each step starting where the last one stopped.
  let scanned = 0;
  let steps = 0;
  for (; steps < 50; steps += 1) {
    const advanced = await step(hour);
    if (advanced?.type !== "advanced") {
      throw new Error(
        `expected an advancing step, got ${String(advanced?.type)}`,
      );
    }
    scanned += advanced.batch.scanned;
    if (advanced.passComplete) {
      break;
    }
  }
  expect(scanned).toBe(total);
  expect(steps).toBeGreaterThan(0);

  // Within the interval the sweep is current, and says so without writing.
  const before = await tupleHeaders();
  expect(await step(hour)).toEqual({ type: "current" });
  expect(await tupleHeaders()).toEqual(before);

  // Once the interval has passed, a new pass starts from the beginning.
  const next = await step(0);
  expect(next?.type).toBe("advanced");
  if (next?.type === "advanced") {
    expect(next.batch.scanned).toBe(2);
  }

  // The daemon ranks at the database's clock; put the fixture's instant back.
  await sweep(1000);
});

test("the contribution weight is a seam the aggregate reads through", async () => {
  // The ranking's open question — whether a citation that overrules should
  // count for less than one that follows — has to be answerable by changing
  // this expression alone. Doubling it must double the weighted sum and touch
  // nothing else, including the citation count.
  const doubled: CitationContributionWeight = (options) =>
    sql`2 * (${citationContributionWeight(options)})`;
  await sweep(1000, { contributionWeight: doubled });

  const expected = citationScore([...CITED_CITATIONS], NOW, SEED_MAP);
  // score = ln(1 + sum), so doubling the sum is ln(1 + 2*(e^score - 1)).
  expect(await authorityOf(citedId)).toBeCloseTo(
    Math.log(1 + 2 * (Math.E ** expected - 1)),
    9,
  );
  expect(await countOf(citedId)).toBe(3);

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
      country: "CZE",
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

test("an unseeded registry recomputes at the default weight", async () => {
  // A registry with no rows renders no CASE branches, and a branchless
  // `CASE ... ELSE 1 END` is a syntax error: the whole recompute failed
  // instead of weighing every citing court at the default nothing ranks.
  try {
    await sweep(1000, { courtWeightEntries: [] });

    const unranked = citationScore([...CITED_CITATIONS], NOW, new Map());
    expect(await authorityOf(citedId)).toBeCloseTo(unranked, 9);
    // Not vacuous: the seeded registry ranks the same citations higher, so the
    // equality above cannot pass on a sweep that ranked them after all.
    expect(unranked).not.toBeCloseTo(
      citationScore([...CITED_CITATIONS], NOW, SEED_MAP),
      2,
    );
  } finally {
    // The corpus is shared with every test below, so a failed assertion must
    // not leave them reading authority computed against an empty registry.
    await sweep(1000);
  }
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
