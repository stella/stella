import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_DECISION_TYPE_HINT } from "@/api/handlers/case-law/citation-decision-type-hint";
import {
  type CitationResolutionCursor,
  readjudicateAmbiguousCitations,
  reopenCitations,
  resolveCitationsForDecision,
} from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_CANDIDATE_SCAN_CAP,
  CITATION_RESOLUTION_RULE,
  MERITS_DECISION_TYPES,
  PROCEDURAL_DECISION_TYPES,
  CITATION_RESOLUTION_STATUS,
} from "@/api/handlers/case-law/citation-resolution-status";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The one-file rule: a constitutional court keeps one docket number for a
 * whole file, so the nález and the procedural orders around it share a
 * citation key. Each case below is a shape the rule must decide one way and
 * no other, and the last one is the rule's door back into settled rows.
 *
 * Mutation: with the `one_file` arm removed from the statement, the first test
 * fails (the row stays `ambiguous`) and every negative case still passes, so
 * the negatives alone would not notice the rule being absent; they guard its
 * edges, the first guards its existence.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const [MERITS] = MERITS_DECISION_TYPES;
const [PROCEDURAL_CZ, PROCEDURAL_SK] = PROCEDURAL_DECISION_TYPES;

const usSource = createSafeId<"caseLawSource">();
const nsSource = createSafeId<"caseLawSource">();

const citing = createSafeId<"caseLawDecision">();
const lateCiting = createSafeId<"caseLawDecision">();
// Cites with the decision type spelled out in the text.
const hintCiting = createSafeId<"caseLawDecision">();

// One file: a nález preceded by two orders.
const fileNalez = createSafeId<"caseLawDecision">();
const fileOrderA = createSafeId<"caseLawDecision">();
const fileOrderB = createSafeId<"caseLawDecision">();
// Two nálezy under one key: the court re-decided the file.
const twinNalezA = createSafeId<"caseLawDecision">();
const twinNalezB = createSafeId<"caseLawDecision">();
// One nález plus a candidate with no recorded type.
const untypedNalez = createSafeId<"caseLawDecision">();
const untypedOrder = createSafeId<"caseLawDecision">();
// A nález at one court, an order under the same key at another.
const crossNalez = createSafeId<"caseLawDecision">();
const crossOrder = createSafeId<"caseLawDecision">();
// The Slovak spelling of the same structure.
const skNalez = createSafeId<"caseLawDecision">();
const skOrder = createSafeId<"caseLawDecision">();
// One nález and one order: the shape the type hint tells apart.
const pairNalez = createSafeId<"caseLawDecision">();
const pairOrder = createSafeId<"caseLawDecision">();
// A file with more holders than the resolver reads.
const crowdedIds = Array.from({ length: CITATION_CANDIDATE_SCAN_CAP }, () =>
  createSafeId<"caseLawDecision">(),
);

const oneFileCitation = createSafeId<"caseLawCitation">();
const twinCitation = createSafeId<"caseLawCitation">();
const untypedCitation = createSafeId<"caseLawCitation">();
const crossCourtCitation = createSafeId<"caseLawCitation">();
const skCitation = createSafeId<"caseLawCitation">();
const crowdedCitation = createSafeId<"caseLawCitation">();
const beforeNalezCitation = createSafeId<"caseLawCitation">();
const hintOrderCitation = createSafeId<"caseLawCitation">();
const hintNalezCitation = createSafeId<"caseLawCitation">();
const hintTwoOrdersCitation = createSafeId<"caseLawCitation">();
const hintTwinCitation = createSafeId<"caseLawCitation">();
const hintNoneCitation = createSafeId<"caseLawCitation">();

// The pglite handle stands in for a transaction, matching the pattern the
// other case-law database tests use for their fakes.
// eslint-disable-next-line typescript/no-unsafe-type-assertion
const asTx = () => db as unknown as Transaction;

const scopedDb = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await fn(asTx());

const us = {
  sourceId: usSource,
  court: "Ústavní soud",
  country: "CZE",
  language: "cs",
  fulltext: "text",
};

const decision = (
  id: SafeId<"caseLawDecision">,
  fields: {
    caseNumber: string;
    citationKey: string;
    decisionDate: string;
    decisionType: string | null;
    court?: string;
    country?: string;
    sourceId?: SafeId<"caseLawSource">;
  },
) => ({
  ...us,
  ...fields,
  id,
  // One file publishes several documents under one number, told apart by
  // the publisher's own id, as the constitutional courts' adapters do.
  sourceDocumentId: id,
  slug: id,
  languageGroupKey: id,
});

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: usSource, adapterKey: "cz-us", name: "constitutional court" },
      { id: nsSource, adapterKey: "cz-ns", name: "supreme court" },
    ]);

    await db.insert(caseLawDecisions).values([
      decision(citing, {
        caseNumber: "Pl. ÚS 1/20",
        citationKey: "plús1/20",
        decisionDate: "2020-06-01",
        decisionType: MERITS,
      }),
      decision(lateCiting, {
        // Decided after the file's first order, before its second and its
        // nález.
        caseNumber: "I. ÚS 2/14",
        citationKey: "iús2/14",
        decisionDate: "2014-12-01",
        decisionType: MERITS,
      }),
      decision(hintCiting, {
        caseNumber: "Pl. ÚS 3/21",
        citationKey: "plús3/21",
        decisionDate: "2021-06-01",
        decisionType: MERITS,
      }),
      decision(pairNalez, {
        caseNumber: "I. ÚS 60/16",
        citationKey: "iús60/16",
        decisionDate: "2016-09-01",
        decisionType: MERITS,
      }),
      decision(pairOrder, {
        caseNumber: "I. ÚS 60/16",
        citationKey: "iús60/16",
        decisionDate: "2016-02-01",
        // Stored with the adapter's capitalisation: the match is case-blind.
        decisionType: "Usnesení",
      }),
      decision(fileOrderA, {
        caseNumber: "II. ÚS 2766/14",
        citationKey: "iiús2766/14",
        decisionDate: "2014-10-08",
        decisionType: PROCEDURAL_CZ,
      }),
      decision(fileOrderB, {
        caseNumber: "II. ÚS 2766/14",
        citationKey: "iiús2766/14",
        decisionDate: "2015-01-20",
        decisionType: PROCEDURAL_CZ,
      }),
      decision(fileNalez, {
        caseNumber: "II. ÚS 2766/14",
        citationKey: "iiús2766/14",
        decisionDate: "2015-12-01",
        decisionType: MERITS,
      }),
      decision(twinNalezA, {
        caseNumber: "III. ÚS 10/16",
        citationKey: "iiiús10/16",
        decisionDate: "2016-05-01",
        decisionType: MERITS,
      }),
      decision(twinNalezB, {
        caseNumber: "III. ÚS 10/16",
        citationKey: "iiiús10/16",
        decisionDate: "2017-05-01",
        decisionType: MERITS,
      }),
      decision(untypedNalez, {
        caseNumber: "IV. ÚS 20/16",
        citationKey: "ivús20/16",
        decisionDate: "2016-09-01",
        decisionType: MERITS,
      }),
      decision(untypedOrder, {
        caseNumber: "IV. ÚS 20/16",
        citationKey: "ivús20/16",
        decisionDate: "2016-02-01",
        decisionType: null,
      }),
      decision(crossNalez, {
        caseNumber: "I. ÚS 30/16",
        citationKey: "iús30/16",
        decisionDate: "2016-09-01",
        decisionType: MERITS,
      }),
      decision(crossOrder, {
        caseNumber: "I. ÚS 30/16",
        citationKey: "iús30/16",
        decisionDate: "2016-02-01",
        decisionType: PROCEDURAL_CZ,
        court: "Nejvyšší soud",
        sourceId: nsSource,
      }),
      decision(skNalez, {
        caseNumber: "II. ÚS 40/16",
        citationKey: "iiús40/16",
        decisionDate: "2016-09-01",
        decisionType: MERITS,
        court: "Ústavný súd SR",
        country: "SVK",
      }),
      decision(skOrder, {
        caseNumber: "II. ÚS 40/16",
        citationKey: "iiús40/16",
        decisionDate: "2016-02-01",
        decisionType: PROCEDURAL_SK,
        court: "Ústavný súd SR",
        country: "SVK",
      }),
      ...crowdedIds.map((id, index) =>
        decision(id, {
          caseNumber: "Pl. ÚS 50/16",
          citationKey: "plús50/16",
          decisionDate: `2016-0${(index % 9) + 1}-01`,
          decisionType: index === 0 ? MERITS : PROCEDURAL_CZ,
        }),
      ),
    ]);

    await db.insert(caseLawCitations).values([
      {
        id: oneFileCitation,
        citingDecisionId: citing,
        citationText: "II. ÚS 2766/14",
        citationKey: "iiús2766/14",
      },
      {
        id: twinCitation,
        citingDecisionId: citing,
        citationText: "III. ÚS 10/16",
        citationKey: "iiiús10/16",
      },
      {
        id: untypedCitation,
        citingDecisionId: citing,
        citationText: "IV. ÚS 20/16",
        citationKey: "ivús20/16",
      },
      {
        id: crossCourtCitation,
        citingDecisionId: citing,
        citationText: "I. ÚS 30/16",
        citationKey: "iús30/16",
      },
      {
        id: crowdedCitation,
        citingDecisionId: citing,
        citationText: "Pl. ÚS 50/16",
        citationKey: "plús50/16",
      },
      {
        id: beforeNalezCitation,
        citingDecisionId: lateCiting,
        citationText: "II. ÚS 2766/14",
        citationKey: "iiús2766/14",
      },
      {
        id: hintOrderCitation,
        citingDecisionId: hintCiting,
        citationText: "I. ÚS 60/16",
        citationKey: "iús60/16",
        citedDecisionTypeHint: CITATION_DECISION_TYPE_HINT.ORDER,
      },
      {
        id: hintNalezCitation,
        citingDecisionId: hintCiting,
        citationText: "I. ÚS 60/16",
        citationKey: "iús60/16",
        citedDecisionTypeHint: CITATION_DECISION_TYPE_HINT.MERITS,
        sectionIndex: 2,
      },
      {
        id: hintTwoOrdersCitation,
        citingDecisionId: hintCiting,
        citationText: "II. ÚS 2766/14",
        citationKey: "iiús2766/14",
        citedDecisionTypeHint: CITATION_DECISION_TYPE_HINT.ORDER,
      },
      {
        id: hintTwinCitation,
        citingDecisionId: hintCiting,
        citationText: "III. ÚS 10/16",
        citationKey: "iiiús10/16",
        citedDecisionTypeHint: CITATION_DECISION_TYPE_HINT.MERITS,
      },
      {
        id: hintNoneCitation,
        citingDecisionId: hintCiting,
        citationText: "I. ÚS 60/16",
        citationKey: "iús60/16",
        citedDecisionTypeHint: CITATION_DECISION_TYPE_HINT.JUDGMENT,
        sectionIndex: 3,
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const rowOf = async (id: SafeId<"caseLawCitation">) => {
  const rows = await db
    .select({
      cited: caseLawCitations.citedDecisionId,
      status: caseLawCitations.resolutionStatus,
      rule: caseLawCitations.resolutionRuleId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, id))
    .limit(1);
  return rows.at(0) ?? null;
};

const byRule = (counts: {
  courtHint?: number;
  uniqueKey?: number;
  typeHint?: number;
  oneFileMerits?: number;
}) => ({
  [CITATION_RESOLUTION_RULE.UNIQUE_KEY]: counts.uniqueKey ?? 0,
  [CITATION_RESOLUTION_RULE.TYPE_HINT]: counts.typeHint ?? 0,
  [CITATION_RESOLUTION_RULE.COURT_HINT]: counts.courtHint ?? 0,
  [CITATION_RESOLUTION_RULE.ONE_FILE_MERITS]: counts.oneFileMerits ?? 0,
});

test("a key held by one nález and its procedural orders resolves to the nález", async () => {
  const counts = await resolveCitationsForDecision(asTx(), citing);
  expect(counts.resolvedByRule[CITATION_RESOLUTION_RULE.ONE_FILE_MERITS]).toBe(
    1,
  );

  expect(await rowOf(oneFileCitation)).toEqual({
    cited: fileNalez,
    rule: CITATION_RESOLUTION_RULE.ONE_FILE_MERITS,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("two nálezy under one key stay ambiguous", async () => {
  expect(await rowOf(twinCitation)).toEqual({
    cited: null,
    rule: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a candidate without a recorded type keeps the key ambiguous", async () => {
  expect(await rowOf(untypedCitation)).toEqual({
    cited: null,
    rule: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a nález and an order at different courts stay ambiguous", async () => {
  expect(await rowOf(crossCourtCitation)).toEqual({
    cited: null,
    rule: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a key with as many holders as the resolver reads stays ambiguous", async () => {
  // The fixture is exactly one nález plus orders at one court — the shape
  // the rule accepts — so only the cap can be what keeps it ambiguous.
  const holders = await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, crowdedIds));
  expect(holders).toHaveLength(CITATION_CANDIDATE_SCAN_CAP);

  expect(await rowOf(crowdedCitation)).toEqual({
    cited: null,
    rule: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a citation older than the nález never takes it", async () => {
  // Only the first order predates the citing decision, so the time rule
  // leaves one candidate and uniqueness, not the one-file rule, links it.
  const counts = await resolveCitationsForDecision(asTx(), lateCiting);
  expect(counts).toMatchObject({
    resolved: 1,
    resolvedByRule: byRule({ uniqueKey: 1 }),
  });
  expect(await rowOf(beforeNalezCitation)).toEqual({
    cited: fileOrderA,
    rule: CITATION_RESOLUTION_RULE.UNIQUE_KEY,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("the Slovak spelling of the file structure resolves the same way", async () => {
  const skCiting = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values(
    decision(skCiting, {
      caseNumber: "III. ÚS 5/20",
      citationKey: "iiiús5/20",
      decisionDate: "2020-01-01",
      decisionType: MERITS,
      court: "Ústavný súd SR",
      country: "SVK",
    }),
  );
  await db.insert(caseLawCitations).values({
    id: skCitation,
    citingDecisionId: skCiting,
    citationText: "II. ÚS 40/16",
    citationKey: "iiús40/16",
  });

  const counts = await resolveCitationsForDecision(asTx(), skCiting);
  expect(counts.resolvedByRule[CITATION_RESOLUTION_RULE.ONE_FILE_MERITS]).toBe(
    1,
  );
  expect(await rowOf(skCitation)).toEqual({
    cited: skNalez,
    rule: CITATION_RESOLUTION_RULE.ONE_FILE_MERITS,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("re-adjudication reopens settled ambiguous rows and is idempotent", async () => {
  // Settle the one-file citation as the old resolver would have: ambiguous,
  // as if the rule had not existed when the walk passed.
  await db
    .update(caseLawCitations)
    .set({
      citedDecisionId: null,
      resolutionStatus: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
    })
    .where(eq(caseLawCitations.id, oneFileCitation));

  const drain = async () => {
    const totals = { scanned: 0, resolved: 0, oneFileMerits: 0, ambiguous: 0 };
    let after: CitationResolutionCursor | null = null;
    for (let turn = 0; turn < 20; turn += 1) {
      const batch = await readjudicateAmbiguousCitations(scopedDb, {
        limit: 2,
        after,
      });
      if (batch.scanned === 0) {
        return totals;
      }
      totals.scanned += batch.scanned;
      totals.resolved += batch.resolved;
      totals.oneFileMerits +=
        batch.resolvedByRule[CITATION_RESOLUTION_RULE.ONE_FILE_MERITS];
      totals.ambiguous += batch.ambiguous;
      after = batch.cursor;
    }
    throw new Error("re-adjudication did not terminate");
  };

  const first = await drain();
  // Four rows are ambiguous by design and one by the stale verdict: the rule
  // flips the stale one and confirms the rest.
  expect(first).toEqual({
    scanned: 5,
    resolved: 1,
    oneFileMerits: 1,
    ambiguous: 4,
  });
  expect(await rowOf(oneFileCitation)).toEqual({
    cited: fileNalez,
    rule: CITATION_RESOLUTION_RULE.ONE_FILE_MERITS,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });

  const second = await drain();
  expect(second).toEqual({
    scanned: 4,
    resolved: 0,
    oneFileMerits: 0,
    ambiguous: 4,
  });
});

test("a hint names the order or the nález of a pair, whichever the text said", async () => {
  const counts = await resolveCitationsForDecision(asTx(), hintCiting);
  // The two pair citations and the no-match fallback are adjudicated; the
  // two-orders and twin cases are not.
  expect(counts.resolvedByRule).toEqual(
    byRule({ typeHint: 2, oneFileMerits: 1 }),
  );
  expect(counts.ambiguous).toBe(2);

  expect(await rowOf(hintOrderCitation)).toEqual({
    cited: pairOrder,
    rule: CITATION_RESOLUTION_RULE.TYPE_HINT,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
  expect(await rowOf(hintNalezCitation)).toEqual({
    cited: pairNalez,
    rule: CITATION_RESOLUTION_RULE.TYPE_HINT,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("a hint that several holders satisfy leaves the row ambiguous, one-file rule withheld", async () => {
  // Without the hint this key resolves to its nález (first test); the text
  // said "usnesení" and two orders fit, so no rule may pick the nález.
  expect(await rowOf(hintTwoOrdersCitation)).toEqual({
    cited: null,
    rule: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
  expect(await rowOf(hintTwinCitation)).toEqual({
    cited: null,
    rule: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a hint no holder satisfies falls back to the one-file rule", async () => {
  expect(await rowOf(hintNoneCitation)).toEqual({
    cited: pairNalez,
    rule: CITATION_RESOLUTION_RULE.ONE_FILE_MERITS,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("reopening a resolved row clears the rule that drew its edge", async () => {
  expect((await rowOf(hintNalezCitation))?.rule).toBe(
    CITATION_RESOLUTION_RULE.TYPE_HINT,
  );
  await scopedDb(async (tx) => {
    await reopenCitations(tx, [hintNalezCitation]);
  });
  expect(await rowOf(hintNalezCitation)).toEqual({
    cited: null,
    rule: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
});

test("every resolved row names a rule and no other row does", async () => {
  // The census invariant the rule column exists for, over everything the
  // tests above settled: a resolved edge with no rule cannot be audited, and
  // a rule on an unresolved row would be counted against a link that is not
  // there.
  const rows = await db
    .select({
      status: caseLawCitations.resolutionStatus,
      rule: caseLawCitations.resolutionRuleId,
    })
    .from(caseLawCitations);
  expect(rows.length).toBeGreaterThan(5);
  for (const row of rows) {
    expect(row.rule === null).toBe(
      row.status !== CITATION_RESOLUTION_STATUS.RESOLVED,
    );
  }
});
