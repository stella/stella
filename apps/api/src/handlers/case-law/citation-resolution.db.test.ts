import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawCitationResolutionProgress,
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  type CitationResolutionCursor,
  classifyCitationsBeforeWrite,
  reopenCitationsForDecisionKey,
  reopenCitationsForKeys,
  reopenCitationsResolvedTo,
  resolveCitationBatch,
  resolveCitationsForDecision,
  tryResolveCitationBatch,
} from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_STATUS,
} from "@/api/handlers/case-law/citation-resolution-status";
import {
  citationKeyOf,
  decisionIdentifiersFromStoredMetadata,
  extractCitations,
  normalizeDecisionIdentifier,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Resolution runs entirely in SQL, so the rules that keep a link honest are
 * join predicates rather than branches a unit test could reach. Each case
 * below is either a wrong edge the citation graph must not contain — a link
 * across a border the citing jurisdiction does not declare it can cross, a
 * link to a decision published later than the one citing it, a link chosen
 * arbitrarily from an ambiguous pair, a self-link — or the outcome the row
 * must be left carrying, which is what stops the resolver re-examining its own
 * settled negatives forever.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
// A case number is unique within a source, so a genuine collision can only
// come from a second court publishing the same number.
const otherSourceId = createSafeId<"caseLawSource">();
const czTarget = createSafeId<"caseLawDecision">();
const skTarget = createSafeId<"caseLawDecision">();
const laterTarget = createSafeId<"caseLawDecision">();
const ambiguousA = createSafeId<"caseLawDecision">();
const ambiguousB = createSafeId<"caseLawDecision">();
const euTarget = createSafeId<"caseLawDecision">();
const euTargetEnglish = createSafeId<"caseLawDecision">();
const citing = createSafeId<"caseLawDecision">();
const euCiting = createSafeId<"caseLawDecision">();
const undeclaredCiting = createSafeId<"caseLawDecision">();

const plainCitation = createSafeId<"caseLawCitation">();
const crossBorderCitation = createSafeId<"caseLawCitation">();
const futureCitation = createSafeId<"caseLawCitation">();
const ambiguousCitation = createSafeId<"caseLawCitation">();
const selfCitation = createSafeId<"caseLawCitation">();
const unkeyedCitation = createSafeId<"caseLawCitation">();
const supranationalCitation = createSafeId<"caseLawCitation">();
const euToNationalCitation = createSafeId<"caseLawCitation">();
const undeclaredCitation = createSafeId<"caseLawCitation">();
// One regional docket number at two courts: the key alone is ambiguous, the
// court named in the citing sentence is not.
const regionalBrno = createSafeId<"caseLawDecision">();
const regionalBudejovice = createSafeId<"caseLawDecision">();
const courtHintedCitation = createSafeId<"caseLawCitation">();
const courtMissedCitation = createSafeId<"caseLawCitation">();

// The pglite handle stands in for a transaction, matching the pattern the
// other case-law database tests use for their fakes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asTx = () => db as unknown as Transaction;

const scopedDb = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await fn(asTx());

const base = {
  sourceId,
  court: "Nejvyšší soud",
  language: "cs",
  fulltext: "text",
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: sourceId, adapterKey: "cz-ns", name: "test source" },
      { id: otherSourceId, adapterKey: "cz-regional", name: "other court" },
    ]);

    await db.insert(caseLawDecisions).values([
      {
        ...base,
        id: citing,
        caseNumber: "99 Cdo 1/2022",
        citationKey: "99cdo/1/2022",
        country: "CZE",
        decisionDate: "2022-01-01",
        slug: "citing",
        languageGroupKey: "citing",
      },
      {
        ...base,
        id: czTarget,
        caseNumber: "21 Cdo 5/2019",
        citationKey: "21cdo/5/2019",
        country: "CZE",
        decisionDate: "2019-05-01",
        slug: "cz-target",
        languageGroupKey: "cz-target",
      },
      {
        // Same key, different country: a Slovak case number can collide
        // with a Czech one and mean an unrelated case, and CZE does not
        // declare SVK as a jurisdiction its citations reach.
        ...base,
        id: skTarget,
        caseNumber: "7 Cdo 9/2019",
        citationKey: "7cdo/9/2019",
        country: "SVK",
        decisionDate: "2019-06-01",
        slug: "sk-target",
        languageGroupKey: "sk-target",
      },
      {
        ...base,
        id: laterTarget,
        caseNumber: "30 Cdo 8/2024",
        citationKey: "30cdo/8/2024",
        country: "CZE",
        decisionDate: "2024-03-01",
        slug: "later",
        languageGroupKey: "later",
      },
      {
        ...base,
        id: ambiguousA,
        caseNumber: "5 Co 2/2018",
        citationKey: "5co/2/2018",
        country: "CZE",
        decisionDate: "2018-02-01",
        slug: "ambiguous-a",
        languageGroupKey: "ambiguous-a",
      },
      {
        ...base,
        id: ambiguousB,
        sourceId: otherSourceId,
        caseNumber: "5 Co 2/2018",
        citationKey: "5co/2/2018",
        country: "CZE",
        decisionDate: "2018-03-01",
        slug: "ambiguous-b",
        languageGroupKey: "ambiguous-b",
      },
      {
        // The Court of Justice: CZE declares it reachable, so a Czech
        // judgment citing it resolves across the border on purpose. Its
        // translations are one judgment, and Czech is the useful target for
        // this Czech citation.
        ...base,
        id: euTarget,
        caseNumber: "C-423/12",
        citationKey: "c-423/12",
        country: "EU",
        decisionDate: "2014-01-16",
        slug: "eu-target",
        languageGroupKey: "eu-target-group",
      },
      {
        ...base,
        id: euTargetEnglish,
        caseNumber: "C-423/12",
        citationKey: "c-423/12",
        country: "EU",
        decisionDate: "2014-01-16",
        language: "en",
        slug: "eu-target-en",
        languageGroupKey: "eu-target-group",
      },
      {
        ...base,
        id: euCiting,
        caseNumber: "C-333/21",
        citationKey: "c-333/21",
        country: "EU",
        decisionDate: "2023-12-21",
        slug: "eu-citing",
        languageGroupKey: "eu-citing",
      },
      {
        // A country no adapter publishes for and no policy declares. Its
        // citations must be passed over, never resolved against a default.
        ...base,
        id: undeclaredCiting,
        caseNumber: "1 Ob 1/2020",
        citationKey: "1ob/1/2020",
        country: "XXX",
        decisionDate: "2020-01-01",
        slug: "undeclared",
        languageGroupKey: "undeclared",
      },
      {
        ...base,
        id: regionalBrno,
        court: "Krajský soud v Brně",
        caseNumber: "65 A 3/2019",
        citationKey: "65a/3/2019",
        country: "CZE",
        decisionDate: "2019-06-02",
        slug: "regional-brno",
        languageGroupKey: "regional-brno",
      },
      {
        ...base,
        id: regionalBudejovice,
        sourceId: otherSourceId,
        court: "Krajský soud v Českých Budějovicích",
        caseNumber: "65 A 3/2019",
        citationKey: "65a/3/2019",
        country: "CZE",
        decisionDate: "2019-05-21",
        slug: "regional-budejovice",
        languageGroupKey: "regional-budejovice",
      },
    ]);

    await db.insert(caseLawCitations).values([
      {
        id: plainCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 21 Cdo 5/2019",
        citationKey: "21cdo/5/2019",
      },
      {
        id: crossBorderCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 7 Cdo 9/2019",
        citationKey: "7cdo/9/2019",
      },
      {
        id: futureCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 30 Cdo 8/2024",
        citationKey: "30cdo/8/2024",
      },
      {
        id: ambiguousCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 5 Co 2/2018",
        citationKey: "5co/2/2018",
      },
      {
        id: selfCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 99 Cdo 1/2022",
        citationKey: "99cdo/1/2022",
      },
      {
        id: unkeyedCitation,
        citingDecisionId: citing,
        citationText: "č. 12/2020 Sb. rozh. tr.",
        citationKey: null,
      },
      {
        id: supranationalCitation,
        citingDecisionId: citing,
        citationText: "C-423/12, Flora May Reyes v. Migrationsverket",
        citationKey: "c-423/12",
      },
      {
        // The reverse of the supranational rule: EU declares no national
        // reach, so a bare national docket in a CJEU judgment stays unmatched.
        id: euToNationalCitation,
        citingDecisionId: euCiting,
        citationText: "21 Cdo 5/2019",
        citationKey: "21cdo/5/2019",
      },
      {
        id: undeclaredCitation,
        citingDecisionId: undeclaredCiting,
        citationText: "21 Cdo 5/2019",
        citationKey: "21cdo/5/2019",
      },
      {
        // The sentence declines the court name; the stored court is in the
        // nominative. The comparison must not care.
        id: courtHintedCitation,
        citingDecisionId: citing,
        citationText: "č. j. 65 A 3/2019-226",
        citationKey: "65a/3/2019",
        citedCourtHint: "Krajského soudu v Českých Budějovicích",
      },
      {
        // A court the corpus does not hold this docket for: no candidate
        // matches, and the key stays ambiguous rather than guessing.
        id: courtMissedCitation,
        citingDecisionId: citing,
        citationText: "č. j. 65 A 3/2019-12",
        citationKey: "65a/3/2019",
        citedCourtHint: "Městského soudu v Praze",
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("resolves a structured citation through its normalized identifier", async () => {
  const targetId = createSafeId<"caseLawDecision">();
  const citingId = createSafeId<"caseLawDecision">();
  const citationId = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: targetId,
      caseNumber: "Example target",
      citationKey: "example target",
      country: "CZE",
      decisionDate: "2019-01-01",
    },
    {
      ...base,
      id: citingId,
      caseNumber: "Example citing",
      citationKey: "example citing",
      country: "CZE",
      decisionDate: "2020-01-01",
    },
  ]);
  await db.insert(caseLawDecisionIdentifiers).values({
    decisionId: targetId,
    type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    value: "347 U.S. 483",
    normalizedValue: "347us483",
  });
  await db.insert(caseLawCitations).values({
    id: citationId,
    citingDecisionId: citingId,
    citationText: "347 US 483",
    citationKey: "347 us 483",
    identifierType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    normalizedIdentifierValue: "347us483",
  });

  await resolveCitationsForDecision(asTx(), citingId);

  const [citation] = await db
    .select()
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, citationId))
    .limit(1);
  expect(citation?.citedDecisionId).toBe(targetId);
  expect(citation?.resolutionStatus).toBe(CITATION_RESOLUTION_STATUS.RESOLVED);
});

test("a Hungarian docket printed the way the courts print it reaches the listed decision", async () => {
  // The target is stored as the adapter stores it: the listed docket is the
  // case number, and the printed docket rides along as a second identifier
  // whose normalized value predates the Hungarian key. The citation comes
  // from real Kúria prose (the recorded decision Gfv.VI.30.197/2024/4).
  const targetId = createSafeId<"caseLawDecision">();
  const citingId = createSafeId<"caseLawDecision">();
  const listed = "Gfv.30429/2014/5";
  const hungarian = { ...base, court: "Kúria", language: "hu", country: "HUN" };
  await db.insert(caseLawDecisions).values([
    {
      ...hungarian,
      id: targetId,
      caseNumber: listed,
      citationKey: citationKeyOf(listed),
      decisionDate: "2015-01-01",
    },
    {
      ...hungarian,
      id: citingId,
      caseNumber: "Gfv.30197/2024/4",
      citationKey: citationKeyOf("Gfv.30197/2024/4"),
      decisionDate: "2024-06-01",
    },
  ]);
  await db.insert(caseLawDecisionIdentifiers).values([
    {
      decisionId: targetId,
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: listed,
      normalizedValue: normalizeDecisionIdentifierValue(
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        listed,
      ),
    },
    {
      decisionId: targetId,
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: "Gfv.VII.30.429/2014/5",
      normalizedValue: "gfv.vii.30.429/2014/5",
    },
  ]);
  const [extracted] = extractCitations([
    {
      index: 0,
      text: "A Kúria a Gfv.VII.30.429/2014/5. számú ítéletével a jogerős ítéletet hatályában fenntartotta.",
    },
  ]);
  if (extracted === undefined) {
    throw new Error("the Kúria docket was not extracted");
  }
  const citationId = createSafeId<"caseLawCitation">();
  await db.insert(caseLawCitations).values({
    id: citationId,
    citingDecisionId: citingId,
    citationText: extracted.citationText,
    citationKey: citationKeyOf(extracted.citationText),
    identifierType: extracted.identifierType,
    normalizedIdentifierValue: normalizeDecisionIdentifierValue(
      extracted.identifierType,
      extracted.identifierValue,
    ),
  });

  await resolveCitationsForDecision(asTx(), citingId);

  const [citation] = await db
    .select()
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, citationId))
    .limit(1);
  expect(citation?.citedDecisionId).toBe(targetId);
  expect(citation?.resolutionStatus).toBe(CITATION_RESOLUTION_STATUS.RESOLVED);
});

// Both sides through the production derivations: the target's keys from its
// listed case number, the citation's from extracted text.
test.each([
  { stored: "EBH.2015.K.38.", text: "lásd EBH 2015.K.38. alatt" },
  {
    stored: "1.2007.PJE",
    text: "az 1/2007. Polgári jogegységi határozat szerint",
  },
  { stored: "2.2009.PK", text: "a PK vélemény 2/2009 szerint" },
])(
  "a Hungarian series citation reaches the listed row $stored",
  async ({ stored, text }) => {
    const hungarian = {
      ...base,
      court: "Kúria",
      language: "hu",
      country: "HUN",
    };
    const targetId = createSafeId<"caseLawDecision">();
    const citingId = createSafeId<"caseLawDecision">();
    const citingCaseNumber = `Pfv.${stored.length}0000/2024/1`;
    await db.insert(caseLawDecisions).values([
      {
        ...hungarian,
        id: targetId,
        caseNumber: stored,
        citationKey: citationKeyOf(stored),
        decisionDate: "2016-01-01",
      },
      {
        ...hungarian,
        id: citingId,
        caseNumber: citingCaseNumber,
        citationKey: citationKeyOf(citingCaseNumber),
        decisionDate: "2024-06-01",
      },
    ]);
    const identifier = {
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: stored,
    } as const;
    await db.insert(caseLawDecisionIdentifiers).values({
      decisionId: targetId,
      ...identifier,
      normalizedValue: normalizeDecisionIdentifier(identifier),
    });
    const [extracted] = extractCitations([{ index: 0, text }]);
    if (extracted === undefined) {
      throw new Error(`nothing extracted from ${text}`);
    }
    const citationId = createSafeId<"caseLawCitation">();
    await db.insert(caseLawCitations).values({
      id: citationId,
      citingDecisionId: citingId,
      citationText: extracted.citationText,
      citationKey: citationKeyOf(extracted.citationText),
      identifierType: extracted.identifierType,
      normalizedIdentifierValue: normalizeDecisionIdentifierValue(
        extracted.identifierType,
        extracted.identifierValue,
      ),
    });

    await resolveCitationsForDecision(asTx(), citingId);

    const [citation] = await db
      .select()
      .from(caseLawCitations)
      .where(eq(caseLawCitations.id, citationId))
      .limit(1);
    expect(citation?.citedDecisionId).toBe(targetId);
    expect(citation?.resolutionStatus).toBe(
      CITATION_RESOLUTION_STATUS.RESOLVED,
    );
  },
);

test("a Constitutional Court ruling is reached by its gazette number and by its reporter entry", async () => {
  // The ruling's identifiers come from its stored parallel citations, as a
  // backfill recomputes them; the citing sentences are real Czech prose.
  const constitutional = { ...base, court: "Ústavní soud", country: "CZE" };
  const rulingId = createSafeId<"caseLawDecision">();
  const citingId = createSafeId<"caseLawDecision">();
  const ruling = {
    caseNumber: "Pl. ÚS 18/01",
    ecli: null,
    metadata: { parallelQuotation: "234/2002 Sb.\nN 53/26 SbNU 73" },
  };
  await db.insert(caseLawDecisions).values([
    {
      ...constitutional,
      id: rulingId,
      caseNumber: ruling.caseNumber,
      citationKey: citationKeyOf(ruling.caseNumber),
      decisionDate: "2002-03-13",
    },
    {
      ...constitutional,
      id: citingId,
      caseNumber: "Pl. ÚS 1/12",
      citationKey: citationKeyOf("Pl. ÚS 1/12"),
      decisionDate: "2012-11-27",
    },
  ]);
  await db.insert(caseLawDecisionIdentifiers).values(
    decisionIdentifiersFromStoredMetadata(ruling).map((identifier) => ({
      decisionId: rulingId,
      type: identifier.type,
      value: identifier.value,
      normalizedValue: normalizeDecisionIdentifier(identifier),
    })),
  );
  const extracted = extractCitations([
    {
      index: 0,
      text: "Ustanovení § 31 odst. 4 zákona č. 82/1998 Sb., ve znění nálezu Ústavního soudu č. 234/2002 Sb., bylo …",
    },
    {
      index: 1,
      text: "Uvedené východisko [srov. též N 53/26 SbNU 73] platí",
    },
  ]);
  await db.insert(caseLawCitations).values(
    extracted.map((citation) => ({
      id: createSafeId<"caseLawCitation">(),
      citingDecisionId: citingId,
      citationText: citation.citationText,
      citationKey: citationKeyOf(citation.citationText),
      identifierType: citation.identifierType,
      normalizedIdentifierValue: normalizeDecisionIdentifierValue(
        citation.identifierType,
        citation.identifierValue,
      ),
    })),
  );

  await resolveCitationsForDecision(asTx(), citingId);

  const rows = await db
    .select({
      text: caseLawCitations.citationText,
      type: caseLawCitations.identifierType,
      cited: caseLawCitations.citedDecisionId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citingDecisionId, citingId));
  // Code-point order over two fixed spellings; no linguistic collation.
  expect(rows.toSorted((a, b) => (a.text < b.text ? -1 : 1))).toEqual([
    {
      text: "234/2002 Sb.",
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      cited: rulingId,
    },
    {
      text: "N 53/26 SbNU 73",
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      cited: rulingId,
    },
  ]);
});

test("a Constitutional Court docket beside its reporter entry still resolves by the docket", async () => {
  // The target carries no collection identifiers, as no ruling does before a
  // backfill: the citation must reach it exactly as it did when the reporter
  // entry beside the docket went unread.
  const constitutional = { ...base, court: "Ústavní soud", country: "CZE" };
  const rulingId = createSafeId<"caseLawDecision">();
  const citingId = createSafeId<"caseLawDecision">();
  const caseNumber = "Pl. ÚS 77/06";
  await db.insert(caseLawDecisions).values([
    {
      ...constitutional,
      id: rulingId,
      caseNumber,
      citationKey: citationKeyOf(caseNumber),
      decisionDate: "2007-02-15",
    },
    {
      ...constitutional,
      id: citingId,
      caseNumber: "Pl. ÚS 2/12",
      citationKey: citationKeyOf("Pl. ÚS 2/12"),
      decisionDate: "2012-11-27",
    },
  ]);
  await db.insert(caseLawDecisionIdentifiers).values(
    decisionIdentifiersFromStoredMetadata({
      caseNumber,
      ecli: null,
      metadata: {},
    }).map((identifier) => ({
      decisionId: rulingId,
      type: identifier.type,
      value: identifier.value,
      normalizedValue: normalizeDecisionIdentifier(identifier),
    })),
  );
  const extracted = extractCitations([
    {
      index: 0,
      text: "obsažené v nálezu ze dne 15. února 2007 sp. zn. Pl. ÚS 77/06 (N 30/44 SbNU 349; 37/2007 Sb.), podle nichž",
    },
  ]);
  expect(extracted).toHaveLength(1);
  await db.insert(caseLawCitations).values(
    extracted.map((citation) => ({
      id: createSafeId<"caseLawCitation">(),
      citingDecisionId: citingId,
      citationText: citation.citationText,
      citationKey: citationKeyOf(citation.citationText),
      identifierType: citation.identifierType,
      normalizedIdentifierValue: normalizeDecisionIdentifierValue(
        citation.identifierType,
        citation.identifierValue,
      ),
    })),
  );

  await resolveCitationsForDecision(asTx(), citingId);

  const rows = await db
    .select({
      type: caseLawCitations.identifierType,
      cited: caseLawCitations.citedDecisionId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citingDecisionId, citingId));
  expect(rows).toEqual([
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, cited: rulingId },
  ]);
});

type CitationRow = {
  cited: string | null;
  status: string;
  attemptedAt: Date | null;
};

const rowOf = async (
  id: SafeId<"caseLawCitation">,
): Promise<CitationRow | null> => {
  const rows = await db
    .select({
      cited: caseLawCitations.citedDecisionId,
      status: caseLawCitations.resolutionStatus,
      attemptedAt: caseLawCitations.resolutionAttemptedAt,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, id))
    .limit(1);
  return rows.at(0) ?? null;
};

/** Walk the whole pending queue to a fixed point, as the daemon does. */
const drain = async () => {
  const totals = {
    scanned: 0,
    resolved: 0,
    unmatched: 0,
    ambiguous: 0,
    jurisdictionBlocked: 0,
    undeclaredJurisdiction: 0,
  };
  let after: CitationResolutionCursor | null = null;
  for (let turn = 0; turn < 20; turn += 1) {
    const batch = await resolveCitationBatch(scopedDb, { limit: 3, after });
    if (batch.scanned === 0) {
      return totals;
    }
    totals.scanned += batch.scanned;
    totals.resolved += batch.resolved;
    totals.unmatched += batch.unmatched;
    totals.ambiguous += batch.ambiguous;
    totals.jurisdictionBlocked += batch.jurisdictionBlocked;
    totals.undeclaredJurisdiction += batch.undeclaredJurisdiction;
    after = batch.cursor;
  }
  throw new Error("the resolution walk did not reach a fixed point");
};

/** Settle exactly one citation, by walking a batch scoped to its decision. */
const resolveCitationBatchFor = async (id: SafeId<"caseLawCitation">) => {
  const rows = await db
    .select({ citing: caseLawCitations.citingDecisionId })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, id))
    .limit(1);
  const citingId = rows.at(0)?.citing;
  if (!citingId) {
    throw new Error("no such citation");
  }
  await db
    .update(caseLawCitations)
    .set({ resolutionStatus: CITATION_RESOLUTION_STATUS.PENDING })
    .where(eq(caseLawCitations.id, id));
  return await resolveCitationsForDecision(asTx(), citingId);
};

test("counts a structured identifier blocked only by jurisdiction", async () => {
  const targetId = createSafeId<"caseLawDecision">();
  const citingId = createSafeId<"caseLawDecision">();
  const citationId = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: targetId,
      caseNumber: "Structured Slovak target",
      citationKey: "structured slovak target",
      country: "SVK",
      decisionDate: "2019-01-01",
    },
    {
      ...base,
      id: citingId,
      caseNumber: "Structured Czech citing",
      citationKey: "structured czech citing",
      country: "CZE",
      decisionDate: "2020-01-01",
    },
  ]);
  await db.insert(caseLawDecisionIdentifiers).values({
    decisionId: targetId,
    type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    value: "Zbierka 123/2019",
    normalizedValue: "zbierka123/2019",
  });
  await db.insert(caseLawCitations).values({
    id: citationId,
    citingDecisionId: citingId,
    citationText: "Zbierka 123/2019",
    citationKey: "zbierka 123/2019",
    identifierType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    normalizedIdentifierValue: "zbierka123/2019",
  });

  const result = await resolveCitationsForDecision(asTx(), citingId);

  expect(result.jurisdictionBlocked).toBe(1);
  expect(result.resolved).toBe(0);
  expect(await rowOf(citationId)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
  });
});

test("the walk settles every keyed citation and terminates", async () => {
  const totals = await drain();
  // Ten keyed rows, one of which belongs to an undeclared jurisdiction and
  // is therefore examined by the scan but settled by nothing.
  expect(totals.scanned).toBe(10);
  expect(totals.undeclaredJurisdiction).toBe(1);
  expect(totals.resolved).toBe(3);
  expect(totals.ambiguous).toBe(2);
  expect(totals.unmatched).toBe(4);
  // A second walk finds only the row it is not allowed to settle: everything
  // it did settle left the predicate, which is the whole point of recording
  // the outcome, and the one row that stays is the one whose jurisdiction
  // nobody has declared a policy for.
  const second = await drain();
  expect(second.scanned).toBe(1);
  expect(second.undeclaredJurisdiction).toBe(1);
});

test("an unambiguous same-jurisdiction citation resolves", async () => {
  expect(await rowOf(plainCitation)).toMatchObject({
    cited: czTarget,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("every examined row records when it was examined", async () => {
  expect((await rowOf(plainCitation))?.attemptedAt).toBeInstanceOf(Date);
  expect((await rowOf(crossBorderCitation))?.attemptedAt).toBeInstanceOf(Date);
});

test("a citation settled before it is written gets the walk's answer", async () => {
  // The pipeline inserts new citations already settled rather than inserting
  // them pending and updating each one. That is only honest if the answer is
  // the walk's: every row the walk settled above is classified again from its
  // own columns, as if it were about to be written, and must come out the
  // same.
  const settled = await db
    .select({
      id: caseLawCitations.id,
      citingDecisionId: caseLawCitations.citingDecisionId,
      citationKey: caseLawCitations.citationKey,
      identifierType: caseLawCitations.identifierType,
      normalizedIdentifierValue: caseLawCitations.normalizedIdentifierValue,
      citedDecisionTypeHint: caseLawCitations.citedDecisionTypeHint,
      citedCourtHint: caseLawCitations.citedCourtHint,
      citedSheetNumber: caseLawCitations.citedSheetNumber,
      citedDecisionDate: caseLawCitations.citedDecisionDate,
      citedDecisionId: caseLawCitations.citedDecisionId,
      resolutionStatus: caseLawCitations.resolutionStatus,
      resolutionRuleId: caseLawCitations.resolutionRuleId,
    })
    .from(caseLawCitations);
  const examined = settled.filter(
    (row) => row.resolutionStatus !== CITATION_RESOLUTION_STATUS.PENDING,
  );
  // Not vacuous: the fixture carries every outcome the walk can reach.
  expect(new Set(examined.map((row) => row.resolutionStatus))).toEqual(
    new Set([
      CITATION_RESOLUTION_STATUS.RESOLVED,
      CITATION_RESOLUTION_STATUS.AMBIGUOUS,
      CITATION_RESOLUTION_STATUS.UNMATCHED,
    ]),
  );
  for (const row of settled) {
    const resolutions = await classifyCitationsBeforeWrite(asTx(), {
      citingDecisionId: row.citingDecisionId,
      citations: [{ ...row, id: createSafeId<"caseLawCitation">() }],
    });
    const [resolution] = [...resolutions.values()];
    if (row.resolutionStatus === CITATION_RESOLUTION_STATUS.PENDING) {
      // Unkeyed, or a jurisdiction with no declared policy: left pending.
      expect(resolution).toBeUndefined();
      continue;
    }
    // The stored rule id is plain text; compared as a value, not a type.
    const actual: unknown = resolution;
    expect(actual).toEqual({
      citedDecisionId: row.citedDecisionId,
      resolutionStatus: row.resolutionStatus,
      resolutionRuleId: row.resolutionRuleId,
    });
  }
});

test("a matching key in a jurisdiction CZE cannot reach does not link", async () => {
  // The citing decision is Czech; the only holder of this key is Slovak, and
  // the Czech policy declares no Slovak reach.
  expect(await rowOf(crossBorderCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
  });
});

test("a citation blocked only by jurisdiction is counted, not linked", async () => {
  // The measurement the cross-border question needs: the resolver states how
  // many links it withheld for jurisdiction alone, so whether Czech decisions
  // really cite Slovak ones is decided on data rather than on a guess.
  const single = await resolveCitationBatchFor(crossBorderCitation);
  expect(single.jurisdictionBlocked).toBe(1);
  expect(single.resolved).toBe(0);
});

test("a decision published later than the citing one does not link", async () => {
  expect(await rowOf(futureCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
  });
});

test("an ambiguous key links to neither candidate and says so", async () => {
  // Recorded as its own outcome rather than as an unmatched row: the
  // adjudication tier reads this queue, and "no candidate" would send it
  // looking for a decision that is already there twice.
  expect(await rowOf(ambiguousCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a docket shared by regional courts links to the court the text names", async () => {
  expect(await rowOf(courtHintedCitation)).toMatchObject({
    cited: regionalBudejovice,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
  const rule = await db
    .select({ rule: caseLawCitations.resolutionRuleId })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, courtHintedCitation))
    .limit(1);
  expect(rule.at(0)?.rule).toBe(CITATION_RESOLUTION_RULE.COURT_HINT);
});

test("a court hint that names no holder leaves the key ambiguous", async () => {
  expect(await rowOf(courtMissedCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a decision does not cite itself", async () => {
  expect(await rowOf(selfCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
  });
});

test("a citation without a key is never examined", async () => {
  expect(await rowOf(unkeyedCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
});

test("a member state's citation reaches its language manifestation of the supranational judgment", async () => {
  expect(await rowOf(supranationalCitation)).toMatchObject({
    cited: euTarget,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("the supranational court's citation does not reach a national corpus", async () => {
  // Reach is the citing jurisdiction's declaration, not a symmetric relation:
  // EU declares none, so a bare national docket in a CJEU judgment matches
  // nothing even though the reverse direction resolves.
  expect(await rowOf(euToNationalCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
  });
});

test("a citing jurisdiction with no declared policy is passed over", async () => {
  // Not resolved against a default: a wrong edge is unrecoverable, an
  // unexamined row is not. It stays pending, and the count is what makes the
  // gap visible instead of silent.
  expect(await rowOf(undeclaredCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
});

test("ingest-time resolution settles only the decision it is given", async () => {
  // What the pipeline calls in the transaction that wrote the citations: the
  // same doctrine, scoped to one citing decision, so a newly stored decision
  // is citable immediately instead of waiting for the standing walk.
  const isolatedCiting = createSafeId<"caseLawDecision">();
  const isolatedCitation = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: isolatedCiting,
    caseNumber: "44 Cdo 4/2023",
    citationKey: "44cdo/4/2023",
    country: "CZE",
    decisionDate: "2023-01-01",
    slug: "isolated-citing",
    languageGroupKey: "isolated-citing",
  });
  await db.insert(caseLawCitations).values({
    id: isolatedCitation,
    citingDecisionId: isolatedCiting,
    citationText: "sp. zn. 21 Cdo 5/2019",
    citationKey: "21cdo/5/2019",
  });

  const counts = await resolveCitationsForDecision(asTx(), isolatedCiting);
  expect(counts).toMatchObject({ scanned: 1, resolved: 1 });
  expect(await rowOf(isolatedCitation)).toMatchObject({
    cited: czTarget,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
  // The rest of the corpus is untouched: this pass is not a whole-table sweep
  // wearing a decision id.
  expect(await rowOf(unkeyedCitation)).toMatchObject({
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
});

test("a decision arriving under an unmatched key reopens it", async () => {
  // The direction that makes a citator catch up with its crawl: the citation
  // gave up because nobody held the key, and now somebody does.
  const arrivingKey = "18tdo/700/2021";
  const arrivingCiting = createSafeId<"caseLawDecision">();
  const arrivingCitation = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: arrivingCiting,
    caseNumber: "50 Cdo 1/2023",
    citationKey: "50cdo/1/2023",
    country: "CZE",
    decisionDate: "2023-06-01",
    slug: "arriving-citing",
    languageGroupKey: "arriving-citing",
  });
  await db.insert(caseLawCitations).values({
    id: arrivingCitation,
    citingDecisionId: arrivingCiting,
    citationText: "sp. zn. 18 Tdo 700/2021",
    citationKey: arrivingKey,
  });
  await resolveCitationsForDecision(asTx(), arrivingCiting);
  expect(await rowOf(arrivingCitation)).toMatchObject({
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
  });

  const arrived = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: arrived,
    caseNumber: "18 Tdo 700/2021",
    citationKey: arrivingKey,
    country: "CZE",
    decisionDate: "2021-09-01",
    slug: "arrived",
    languageGroupKey: "arrived",
  });
  const reopened = await reopenCitationsForDecisionKey(asTx(), {
    citationKey: arrivingKey,
    decisionId: arrived,
    jurisdiction: "CZE",
    decisionDate: "2021-09-01",
  });
  expect(reopened).toBe(1);
  expect(await rowOf(arrivingCitation)).toMatchObject({
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });

  await drain();
  expect(await rowOf(arrivingCitation)).toMatchObject({
    cited: arrived,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });
});

test("a second decision under a resolved key retracts the edge", async () => {
  // The direction that quietly rots a graph if it is skipped: the edge was
  // honest when it was drawn, and a second holder of the same key makes it a
  // guess. Keeping it would leave a wrong number in the authority ranking
  // that nothing ever revisits.
  const contestedKey = "9as/12/2015";
  const contestedCiting = createSafeId<"caseLawDecision">();
  const contestedCitation = createSafeId<"caseLawCitation">();
  const firstHolder = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: firstHolder,
      caseNumber: "9 As 12/2015",
      citationKey: contestedKey,
      country: "CZE",
      decisionDate: "2015-04-01",
      slug: "first-holder",
      languageGroupKey: "first-holder",
    },
    {
      ...base,
      id: contestedCiting,
      caseNumber: "60 Cdo 1/2023",
      citationKey: "60cdo/1/2023",
      country: "CZE",
      decisionDate: "2023-07-01",
      slug: "contested-citing",
      languageGroupKey: "contested-citing",
    },
  ]);
  await db.insert(caseLawCitations).values({
    id: contestedCitation,
    citingDecisionId: contestedCiting,
    citationText: "č. j. 9 As 12/2015",
    citationKey: contestedKey,
  });
  await resolveCitationsForDecision(asTx(), contestedCiting);
  expect(await rowOf(contestedCitation)).toMatchObject({
    cited: firstHolder,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });

  const secondHolder = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: secondHolder,
    sourceId: otherSourceId,
    caseNumber: "9 As 12/2015",
    citationKey: contestedKey,
    country: "CZE",
    decisionDate: "2015-09-01",
    slug: "second-holder",
    languageGroupKey: "second-holder",
  });
  const reopened = await reopenCitationsForDecisionKey(asTx(), {
    citationKey: contestedKey,
    decisionId: secondHolder,
    jurisdiction: "CZE",
    decisionDate: "2015-09-01",
  });
  expect(reopened).toBe(1);
  expect(await rowOf(contestedCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });

  await drain();
  expect(await rowOf(contestedCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });
});

test("a resolved link with no target is unsettled, not settled", async () => {
  // `cited_decision_id` is ON DELETE SET NULL, so deleting a cited decision
  // leaves a row that says `resolved` and points at nothing. A status-only
  // predicate would step over it forever — it is not pending, and no arriving
  // decision can revive it because the reopen path joins through the target
  // that is gone. The walk has to treat the pair as unsettled.
  const orphanCiting = createSafeId<"caseLawDecision">();
  const orphanTarget = createSafeId<"caseLawDecision">();
  const orphanCitation = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: orphanTarget,
      caseNumber: "77 Cdo 7/2017",
      citationKey: "77cdo/7/2017",
      country: "CZE",
      decisionDate: "2017-01-01",
      slug: "orphan-target",
      languageGroupKey: "orphan-target",
    },
    {
      ...base,
      id: orphanCiting,
      caseNumber: "78 Cdo 8/2023",
      citationKey: "78cdo/8/2023",
      country: "CZE",
      decisionDate: "2023-01-01",
      slug: "orphan-citing",
      languageGroupKey: "orphan-citing",
    },
  ]);
  await db.insert(caseLawCitations).values({
    id: orphanCitation,
    citingDecisionId: orphanCiting,
    citationText: "sp. zn. 77 Cdo 7/2017",
    citationKey: "77cdo/7/2017",
  });
  await resolveCitationsForDecision(asTx(), orphanCiting);
  expect(await rowOf(orphanCitation)).toMatchObject({
    cited: orphanTarget,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });

  await db
    .delete(caseLawDecisions)
    .where(eq(caseLawDecisions.id, orphanTarget));
  expect(await rowOf(orphanCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });

  // The walk picks it up and re-decides it rather than leaving a link that
  // claims a target it does not have.
  await drain();
  expect(await rowOf(orphanCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.UNMATCHED,
  });
});

test("a decision whose identity changes retracts the edges drawn to it", async () => {
  // The complement of the arriving-decision path, which deliberately excludes
  // the decision's own links. Case number, jurisdiction and date are all
  // filters in the candidate join, so an edge decided against the old values
  // is a guess once any of them changes, and nothing else would ever ask.
  const movedTarget = createSafeId<"caseLawDecision">();
  const movedCiting = createSafeId<"caseLawDecision">();
  const movedCitation = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: movedTarget,
      caseNumber: "80 Cdo 1/2016",
      citationKey: "80cdo/1/2016",
      country: "CZE",
      decisionDate: "2016-01-01",
      slug: "moved-target",
      languageGroupKey: "moved-target",
    },
    {
      ...base,
      id: movedCiting,
      caseNumber: "81 Cdo 1/2023",
      citationKey: "81cdo/1/2023",
      country: "CZE",
      decisionDate: "2023-01-01",
      slug: "moved-citing",
      languageGroupKey: "moved-citing",
    },
  ]);
  await db.insert(caseLawCitations).values({
    id: movedCitation,
    citingDecisionId: movedCiting,
    citationText: "sp. zn. 80 Cdo 1/2016",
    citationKey: "80cdo/1/2016",
  });
  await resolveCitationsForDecision(asTx(), movedCiting);
  expect(await rowOf(movedCitation)).toMatchObject({
    cited: movedTarget,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });

  expect(await reopenCitationsResolvedTo(asTx(), movedTarget)).toBe(1);
  expect(await rowOf(movedCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
});

test("a key gaining a second holder retracts the edge, in bulk too", async () => {
  // What the key backfill creates when it assigns a key another decision
  // already holds: the edge drawn to the first holder becomes a guess. The
  // bulk path has to make that transition as well as the single-decision one,
  // or a backfill leaves an arbitrary authority edge behind.
  const bulkKey = "33cdo/2178/2018";
  const bulkCiting = createSafeId<"caseLawDecision">();
  const bulkCitation = createSafeId<"caseLawCitation">();
  const firstHolder = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values([
    {
      ...base,
      id: firstHolder,
      caseNumber: "33 Cdo 2178/2018",
      citationKey: bulkKey,
      country: "CZE",
      decisionDate: "2018-05-01",
      slug: "bulk-first",
      languageGroupKey: "bulk-first",
    },
    {
      ...base,
      id: bulkCiting,
      caseNumber: "70 Cdo 1/2023",
      citationKey: "70cdo/1/2023",
      country: "CZE",
      decisionDate: "2023-08-01",
      slug: "bulk-citing",
      languageGroupKey: "bulk-citing",
    },
  ]);
  await db.insert(caseLawCitations).values({
    id: bulkCitation,
    citingDecisionId: bulkCiting,
    citationText: "sp. zn. 33 Cdo 2178/2018",
    citationKey: bulkKey,
  });
  await resolveCitationsForDecision(asTx(), bulkCiting);
  expect(await rowOf(bulkCitation)).toMatchObject({
    cited: firstHolder,
    status: CITATION_RESOLUTION_STATUS.RESOLVED,
  });

  // A second decision is given the same key, as the backfill would.
  const secondHolder = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: secondHolder,
    sourceId: otherSourceId,
    caseNumber: "33 Cdo 2178/2018",
    citationKey: bulkKey,
    country: "CZE",
    decisionDate: "2018-11-01",
    slug: "bulk-second",
    languageGroupKey: "bulk-second",
  });
  expect(await reopenCitationsForKeys(asTx(), [bulkKey])).toBe(1);
  expect(await rowOf(bulkCitation)).toMatchObject({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });

  await drain();
  expect(await rowOf(bulkCitation)).toMatchObject({
    status: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  });

  // And an ambiguous row is reachable by key, which is the only handle it has:
  // it carries no target, so nothing searching by target could find it. This
  // is what lets a candidate leaving the key make the remaining one unique.
  expect(await reopenCitationsForKeys(asTx(), [bulkKey])).toBe(1);
  expect(await rowOf(bulkCitation)).toMatchObject({
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });
  await drain();
});

test("the walk's position is advanced and wrapped under its own lock", async () => {
  // The position is read and written inside the locked batch transaction, so
  // no caller can persist a stale one. A batch that settles rows leaves a
  // position behind; a batch that finds nothing writes the wrap, so a task
  // stopping right after draining does not resume at the far end of a queue
  // that has since been refilled behind it.
  const positionAfterBatch =
    async (): Promise<CitationResolutionCursor | null> => {
      const rows = await db
        .select({
          citingDecisionId:
            caseLawCitationResolutionProgress.cursorCitingDecisionId,
          citationId: caseLawCitationResolutionProgress.cursorCitationId,
        })
        .from(caseLawCitationResolutionProgress);
      const row = rows.at(0);
      return row?.citingDecisionId && row.citationId
        ? { citingDecisionId: row.citingDecisionId, citationId: row.citationId }
        : null;
    };

  const reopenedCiting = createSafeId<"caseLawDecision">();
  const reopenedCitation = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values({
    ...base,
    id: reopenedCiting,
    caseNumber: "90 Cdo 1/2024",
    citationKey: "90cdo/1/2024",
    country: "CZE",
    decisionDate: "2024-01-01",
    slug: "cursor-citing",
    languageGroupKey: "cursor-citing",
  });
  await db.insert(caseLawCitations).values({
    id: reopenedCitation,
    citingDecisionId: reopenedCiting,
    citationText: "sp. zn. 21 Cdo 5/2019",
    citationKey: "21cdo/5/2019",
  });

  const settled = await tryResolveCitationBatch(scopedDb, { limit: 1 });
  expect(settled?.scanned).toBeGreaterThan(0);
  expect(await positionAfterBatch()).not.toBeNull();

  // Walk to the end; the batch that finds nothing wraps the position.
  for (let turn = 0; turn < 30; turn += 1) {
    const batch = await tryResolveCitationBatch(scopedDb, { limit: 5 });
    if (batch?.scanned === 0) {
      break;
    }
  }
  expect(await positionAfterBatch()).toBeNull();
});

test("the database refuses an empty citation key on either side", async () => {
  // Null already means "does not canonicalize". The empty string is the same
  // absence wearing a value's clothes, and two rows carrying it would join
  // each other; one writer used to store it where the other stored null.
  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead. `.execute()`
  // rather than the builder, which is a thenable and not a promise.
  //
  // The constraint is named in the assertion, not merely "something threw":
  // these inserts omit columns that could fail for unrelated reasons, so a
  // NOT NULL violation, a foreign-key failure, or a future required column
  // would each keep this green while the constraint it exists for is absent.
  // Drizzle wraps the driver error and puts the query text in its own message,
  // so the constraint name lives on the cause; read the whole chain.
  const messageChain = (error: unknown): string => {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(" | ");
  };
  const rejectionOf = async (run: Promise<unknown>): Promise<string> =>
    await run.then(
      () => "no rejection",
      (error: unknown) => messageChain(error),
    );

  expect(
    await rejectionOf(
      db
        .insert(caseLawDecisions)
        .values({
          ...base,
          id: createSafeId<"caseLawDecision">(),
          caseNumber: "?",
          citationKey: "",
          country: "CZE",
          slug: "empty-key",
          languageGroupKey: "empty-key",
        })
        .execute(),
    ),
  ).toContain("decisions_citation_key_non_empty");
  expect(
    await rejectionOf(
      db
        .insert(caseLawCitations)
        .values({
          id: createSafeId<"caseLawCitation">(),
          citingDecisionId: citing,
          citationText: "?",
          citationKey: "",
        })
        .execute(),
    ),
  ).toContain("citations_citation_key_non_empty");
});
