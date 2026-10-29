import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import type { ExtractionWarnings } from "@stll/api-contract/case-law-extraction-warnings";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  caseLawCitationDoctrineReviews,
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { readGatedDecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import {
  CITATION_SUMMARY_SCAN_LIMIT,
  CITATION_TIMELINE_MAX_YEARS,
  listDecisionCitationsHandler,
  listLeadingCitationsHandler,
  listTopCitingDecisionsHandler,
  summarizeDecisionCitationsHandler,
  summarizeDecisionDoctrineHandler,
  treatmentOf,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type { DecisionCitationRow } from "@/api/handlers/case-law/decisions/citation-graph";
import { readGatedDecisionCitations } from "@/api/handlers/case-law/decisions/citation-passages";
import {
  CITATION_REVIEW_ORIGIN,
  POLARITIES,
  POLARITY,
} from "@/api/handlers/case-law/polarity/consts";
import { citationSummaryResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  CITATION_DIRECTIONS,
  CITATION_TREATMENTS,
} from "@/api/lib/case-law/citation-vocabulary";
import type { CitationDirection } from "@/api/lib/case-law/citation-vocabulary";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const withheldSourceId = createSafeId<"caseLawSource">();
const subjectId = createSafeId<"caseLawDecision">();
const openRelatedId = createSafeId<"caseLawDecision">();
const closedRelatedId = createSafeId<"caseLawDecision">();
const withheldSubjectId = createSafeId<"caseLawDecision">();
const unavailableRelatedId = createSafeId<"caseLawDecision">();

/**
 * A second subject whose related decisions share the open source, the
 * country and one treatment, so publication alone separates them. The
 * listing-only row outranks every eligible leader: any read that lets it
 * through shows it first and pushes an eligible leader out.
 */
const rankedSubjectId = createSafeId<"caseLawDecision">();
const topLeaderId = createSafeId<"caseLawDecision">();
const middleLeaderId = createSafeId<"caseLawDecision">();
const thirdLeaderId = createSafeId<"caseLawDecision">();
const thirdLeaderSiblingId = createSafeId<"caseLawDecision">();
const listingOnlyRelatedId = createSafeId<"caseLawDecision">();
const RANKED_LEADERS = [
  { id: topLeaderId, authority: 3 },
  { id: middleLeaderId, authority: 2 },
  { id: thirdLeaderId, authority: 1 },
] as const;
const LISTING_ONLY_AUTHORITY = 9;
const RANKED_LANGUAGE_GROUP_KEY = "ECLI:CZ:US:2021:RANKED.1";
const LISTING_ONLY_METADATA = {
  _stellaPartialObservation: {
    caseNumberIsPlaceholder: false,
    isListingOnly: true,
  },
};
/** Citation order puts the listing-only row first and the leaders reversed. */
const RANKED_CITATION_ORDER = [
  listingOnlyRelatedId,
  thirdLeaderId,
  middleLeaderId,
  topLeaderId,
] as const;

/** The summary of a visible decision; a 404 here is a test failure. */
const summaryOf = async (
  options: Parameters<typeof summarizeDecisionCitationsHandler>[0],
) => {
  const result = await summarizeDecisionCitationsHandler(options);
  if (!("incoming" in result)) {
    throw new Error("expected a citation summary, got a status response");
  }
  const projected = projectResponseText(result, citationSummaryResponseSchema);
  expect(v.is(citationSummaryResponseSchema, projected)).toBe(true);
  return projected;
};

const citationId = (value: number): SafeId<"caseLawCitation"> =>
  toSafeId<"caseLawCitation">(
    `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`,
  );

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;

/**
 * Every stored polarity spelling, with the unclassified ones first so the
 * fixture proves both `null` and `unknown` fold into one bucket.
 */
const STORED_POLARITIES = [
  null,
  POLARITY.UNKNOWN,
  ...POLARITIES.filter((polarity) => polarity !== POLARITY.UNKNOWN),
] as const;

/** Incoming rows per stored polarity: enough to cross one page boundary. */
const INCOMING_PER_POLARITY = 9;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (tx) =>
          // SAFETY: the role transaction has the same Drizzle read surface as
          // the public-law handle; writes remain on the owner database above.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite test transaction stands in for the public read handle
          await fn(tx as unknown as CaseLawPublicReadTransaction),
      );
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values([
      caseLawSourceRow({ adapterKey: "open", id: openSourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: "closed",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
        id: closedSourceId,
        name: "closed",
      }),
      caseLawSourceRow({
        adapterKey: "withheld",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: true,
          attribution: null,
          license: "permitted-redistribution",
        },
        id: withheldSourceId,
        name: "withheld",
      }),
    ]);
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "subject",
        country: "CZE",
        court: "Court",
        id: subjectId,
        language: "cs",
        sourceId: openSourceId,
      },
      {
        caseNumber: "open-related",
        country: "CZE",
        court: "Related court",
        sourceUrl: "https://example.test/decision/open-related",
        decisionDate: "2020-02-03",
        decisionType: "nález",
        ecli: "ECLI:CZ:US:2020:1.US.1.20.2",
        id: openRelatedId,
        language: "cs",
        slug: "open-related",
        sourceId: openSourceId,
      },
      {
        caseNumber: "closed-related",
        country: "CZE",
        court: "Court",
        id: closedRelatedId,
        language: "cs",
        sourceId: closedSourceId,
      },
      {
        caseNumber: "withheld-subject",
        country: "CZE",
        court: "Court",
        id: withheldSubjectId,
        language: "cs",
        sourceId: withheldSourceId,
      },
      {
        caseNumber: "unavailable-related",
        country: "XAA",
        court: "Synthetic court",
        id: unavailableRelatedId,
        language: "xx",
        sourceId: openSourceId,
      },
      {
        caseNumber: "ranked-subject",
        country: "CZE",
        court: "Court",
        id: rankedSubjectId,
        language: "cs",
        sourceId: openSourceId,
      },
      ...RANKED_LEADERS.map(({ authority, id }) => ({
        caseNumber: `leader-${String(authority)}`,
        citationAuthority: authority,
        country: "CZE",
        court: "Court",
        id,
        language: "cs",
        languageGroupKey:
          id === thirdLeaderId ? RANKED_LANGUAGE_GROUP_KEY : null,
        slug: `leader-${String(authority)}`,
        sourceId: openSourceId,
      })),
      {
        caseNumber: "third-leader-sibling",
        country: "CZE",
        court: "Court",
        id: thirdLeaderSiblingId,
        language: "en",
        languageGroupKey: RANKED_LANGUAGE_GROUP_KEY,
        slug: "third-leader-sibling",
        sourceId: openSourceId,
      },
      {
        caseNumber: "listing-only-related",
        citationAuthority: LISTING_ONLY_AUTHORITY,
        country: "CZE",
        court: "Court",
        id: listingOnlyRelatedId,
        language: "sk",
        languageGroupKey: RANKED_LANGUAGE_GROUP_KEY,
        metadata: LISTING_ONLY_METADATA,
        slug: "listing-only-related",
        sourceId: openSourceId,
      },
    ]);

    let nextId = 0;
    const rows: (typeof caseLawCitations.$inferInsert)[] = [];
    for (const polarity of STORED_POLARITIES) {
      for (let index = 0; index < INCOMING_PER_POLARITY; index += 1) {
        rows.push({
          citedDecisionId: subjectId,
          citingDecisionId: openRelatedId,
          citationText: `incoming-${polarity ?? "null"}-${String(index)}`,
          id: citationId(nextId),
          polarity,
        });
        nextId += 1;
      }
    }
    rows.push(
      // Restricted citing decision: absent from the list and the rollup.
      {
        citedDecisionId: subjectId,
        citingDecisionId: closedRelatedId,
        citationText: "restricted-incoming",
        id: citationId(nextId),
        polarity: POLARITY.NEGATIVE,
      },
      // Procedural history: not part of the graph in either direction.
      {
        citedDecisionId: subjectId,
        citingDecisionId: openRelatedId,
        citationText: "procedural-incoming",
        id: citationId(nextId + 1),
        kind: CITATION_KIND.PROCEDURAL,
        polarity: POLARITY.NEGATIVE,
      },
      {
        citedDecisionId: openRelatedId,
        citingDecisionId: subjectId,
        citationText: "procedural-outgoing",
        id: citationId(nextId + 2),
        kind: CITATION_KIND.PROCEDURAL,
      },
      // Outgoing: one resolved, one unresolved, one restricted.
      {
        citedDecisionId: openRelatedId,
        citingDecisionId: subjectId,
        citationText: "outgoing-resolved",
        id: citationId(nextId + 3),
        polarity: POLARITY.POSITIVE,
      },
      {
        citedDecisionId: null,
        citingDecisionId: subjectId,
        citationText: "outgoing-unresolved",
        id: citationId(nextId + 4),
      },
      {
        citedDecisionId: closedRelatedId,
        citingDecisionId: subjectId,
        citationText: "outgoing-restricted",
        id: citationId(nextId + 5),
        polarity: POLARITY.POSITIVE,
      },
      {
        citedDecisionId: subjectId,
        citingDecisionId: unavailableRelatedId,
        citationText: "unavailable-incoming",
        id: citationId(nextId + 6),
      },
      {
        citedDecisionId: unavailableRelatedId,
        citingDecisionId: subjectId,
        citationText: "unavailable-outgoing",
        id: citationId(nextId + 7),
      },
    );
    for (const [index, relatedId] of RANKED_CITATION_ORDER.entries()) {
      rows.push(
        {
          citedDecisionId: rankedSubjectId,
          citingDecisionId: relatedId,
          citationText: `ranked-incoming-${String(index)}`,
          id: citationId(600 + index),
          polarity: POLARITY.POSITIVE,
        },
        {
          citedDecisionId: relatedId,
          citingDecisionId: rankedSubjectId,
          citationText: `ranked-outgoing-${String(index)}`,
          id: citationId(700 + index),
          polarity: POLARITY.POSITIVE,
        },
      );
    }
    await db.insert(caseLawCitations).values(rows);
    await db.insert(caseLawCitations).values({
      citedDecisionId: null,
      citingDecisionId: withheldSubjectId,
      citationText: "citation-text-fixture",
      id: citationId(999),
    });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const withSubject = async <T>(
  id: SafeId<"caseLawDecision">,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
): Promise<T> =>
  (await withRedistributableSubject(
    caseLawDb,
    "pages",
    { kind: "id", id },
    read,
  )) ?? panic("expected a redistributable subject");

const readCitationPage = async (
  direction: CitationDirection,
  cursor: string | undefined,
) =>
  await withSubject(
    subjectId,
    async (subject) =>
      await listDecisionCitationsHandler({
        subject,
        query: { direction, ...(cursor === undefined ? {} : { cursor }) },
      }),
  );

const collect = async (direction: CitationDirection) => {
  const items: DecisionCitationRow[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (let request = 0; request < 4; request += 1) {
    const page = await readCitationPage(direction, cursor);
    if (!("items" in page)) {
      throw new Error("expected a citation page");
    }
    pages += 1;
    expect(page.items.length).toBeLessThanOrEqual(page.limit);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) {
      break;
    }
  }

  return { cursor, items, pages };
};

test("treatment folds both unclassified spellings and passes the rest by name", () => {
  expect(treatmentOf(null)).toBe("unclassified");
  expect(treatmentOf(POLARITY.UNKNOWN)).toBe("unclassified");
  expect(treatmentOf("not-a-polarity")).toBe("unclassified");
  for (const polarity of POLARITIES) {
    if (polarity === POLARITY.UNKNOWN) {
      continue;
    }
    expect(treatmentOf(polarity)).toBe(polarity);
  }
  // Declared set equals reachable set in both directions.
  const reachable = new Set([null, ...POLARITIES].map(treatmentOf));
  expect([...reachable].toSorted()).toEqual(
    [...CITATION_TREATMENTS].toSorted(),
  );
});

test("incoming pages carry treatment and the citing decision, and the rollup matches them", async () => {
  const incoming = await collect("incoming");

  // 7 stored spellings × 9 rows = 63 visible precedent rows over two pages.
  expect(incoming.pages).toBe(2);
  expect(incoming.cursor).toBeUndefined();
  expect(incoming.items).toHaveLength(
    STORED_POLARITIES.length * INCOMING_PER_POLARITY,
  );
  expect(
    incoming.items.some(
      (item) =>
        item.citationText === "restricted-incoming" ||
        item.citationText === "unavailable-incoming" ||
        item.citationText === "procedural-incoming",
    ),
  ).toBe(false);
  for (const item of incoming.items) {
    expect(item.decision).toEqual({
      id: openRelatedId,
      caseNumber: "open-related",
      caseNumberType: "case-number",
      citationAuthority: 0,
      country: "CZE",
      court: "Related court",
      courtAbbreviation: "ÚS",
      sourceUrl: "https://example.test/decision/open-related",
      decisionDate: "2020-02-03",
      decisionType: "nález",
      ecli: "ECLI:CZ:US:2020:1.US.1.20.2",
      language: "cs",
      languageAlternates: [],
      slug: "open-related",
    });
  }

  const counted = new Map<string, number>();
  for (const item of incoming.items) {
    counted.set(item.treatment, (counted.get(item.treatment) ?? 0) + 1);
  }
  const summary = await withSubject(
    subjectId,
    async (subject) => await summaryOf({ subject }),
  );
  expect(Object.fromEntries(counted)).toEqual(
    Object.fromEntries(
      Object.entries(summary.incoming).filter(([, count]) => count > 0),
    ),
  );
  // null and unknown land in one bucket; the restricted negative row does not.
  expect(summary.incoming.unclassified).toBe(2 * INCOMING_PER_POLARITY);
  expect(summary.incoming.negative).toBe(INCOMING_PER_POLARITY);
});

test("outgoing keeps unresolved text, drops restricted and procedural rows", async () => {
  const outgoing = await collect("outgoing");

  expect(outgoing.items.map((item) => item.citationText)).toEqual([
    "outgoing-resolved",
    "outgoing-unresolved",
  ]);
  expect(outgoing.items.at(0)?.decision?.id).toBe(openRelatedId);
  expect(outgoing.items.at(0)?.treatment).toBe(POLARITY.POSITIVE);
  expect(outgoing.items.at(1)?.decision).toBeNull();
  expect(outgoing.items.at(1)?.treatment).toBe("unclassified");

  const summary = await withSubject(
    subjectId,
    async (subject) => await summaryOf({ subject }),
  );
  expect(summary.outgoing).toEqual({
    negative: 0,
    neutral: 0,
    positive: 1,
    supportive: 0,
    mixed: 0,
    unclassified: 1,
  });
});

test("citation pages reject malformed cursors", async () => {
  const page = await withSubject(
    subjectId,
    async (subject) =>
      await listDecisionCitationsHandler({
        subject,
        query: { cursor: "not-a-cursor", direction: "incoming" },
      }),
  );

  expect("items" in page).toBe(false);
});

test("citation pages filter doctrine and polarity and bind cursors to filters", async () => {
  const limitsId = citationId(0);
  const distinguishesId = citationId(1);
  await db
    .update(caseLawCitations)
    .set({ doctrinalTreatment: "limits", polarity: POLARITY.NEGATIVE })
    .where(eq(caseLawCitations.id, limitsId));
  await db
    .update(caseLawCitations)
    .set({ doctrinalTreatment: "distinguishes", polarity: POLARITY.NEGATIVE })
    .where(eq(caseLawCitations.id, distinguishesId));
  await db.execute(
    sql`GRANT SELECT (citation_key, doctrinal_treatment) ON case_law_citations TO stella_public_law_reader`,
  );
  await db.execute(
    sql`GRANT SELECT (citing_decision_id, citation_key, doctrinal_treatment, evidence_quote) ON case_law_citation_doctrine_reviews TO stella_public_law_reader`,
  );

  const read = async (
    query: Parameters<typeof listDecisionCitationsHandler>[0]["query"],
    limit = 50,
  ) =>
    await withSubject(
      subjectId,
      async (subject) =>
        await listDecisionCitationsHandler({ subject, query, limit }),
    );
  const limits = await read({ direction: "incoming", doctrine: "limits" });
  const negative = await read({ direction: "incoming", polarity: "negative" });
  const combined = await read({
    direction: "incoming",
    doctrine: "limits",
    polarity: "negative",
  });
  const empty = await read({
    direction: "incoming",
    doctrine: "limits",
    polarity: "supportive",
  });
  if (
    !("items" in limits) ||
    !("items" in negative) ||
    !("items" in combined) ||
    !("items" in empty)
  ) {
    throw new Error("Expected filtered citation pages");
  }
  expect(limits.items.map(({ id }) => id)).toEqual([limitsId]);
  expect(negative.items.some(({ id }) => id === limitsId)).toBe(true);
  expect(combined.items.map(({ id }) => id)).toEqual([limitsId]);
  expect(empty.items).toEqual([]);

  const first = await read({ direction: "incoming", polarity: "negative" }, 1);
  if (!("items" in first) || first.nextCursor === null) {
    throw new Error("Expected a filtered cursor");
  }
  expect(
    "items" in
      (await read({
        cursor: first.nextCursor,
        direction: "incoming",
        polarity: "positive",
      })),
  ).toBe(false);

  await db.execute(
    sql`REVOKE SELECT (citation_key, doctrinal_treatment) ON case_law_citations FROM stella_public_law_reader`,
  );
  await db.execute(
    sql`REVOKE SELECT (citing_decision_id, citation_key, doctrinal_treatment, evidence_quote) ON case_law_citation_doctrine_reviews FROM stella_public_law_reader`,
  );
  await db
    .update(caseLawCitations)
    .set({ doctrinalTreatment: null, polarity: null })
    .where(inArray(caseLawCitations.id, [limitsId, distinguishesId]));
});

test("unclassified polarity returns only unread stances across stable pages", async () => {
  const read = async (cursor?: string) =>
    await withSubject(
      subjectId,
      async (subject) =>
        await listDecisionCitationsHandler({
          subject,
          query: {
            direction: "incoming",
            polarity: "unclassified",
            ...(cursor === undefined ? {} : { cursor }),
          },
          limit: 5,
        }),
    );

  const first = await read();
  const repeatedFirst = await read();
  if (
    !("items" in first) ||
    !("items" in repeatedFirst) ||
    first.nextCursor === null
  ) {
    throw new Error("Expected a first unclassified citation page");
  }
  expect(repeatedFirst.nextCursor).toBe(first.nextCursor);

  const items = [...first.items];
  let cursor: string | null = first.nextCursor;
  while (cursor !== null) {
    const page = await read(cursor);
    if (!("items" in page)) {
      throw new Error("Expected a subsequent unclassified citation page");
    }
    items.push(...page.items);
    cursor = page.nextCursor;
  }

  expect(items).toHaveLength(2 * INCOMING_PER_POLARITY);
  expect(new Set(items.map(({ id }) => id)).size).toBe(items.length);
  expect(items.every(({ treatment }) => treatment === "unclassified")).toBe(
    true,
  );
  expect(items.map(({ id }) => id)).toEqual(
    Array.from({ length: 2 * INCOMING_PER_POLARITY }, (_, index) =>
      citationId(index),
    ),
  );
});

test("doctrine filters report unavailable instead of an empty finding", async () => {
  const page = await withSubject(
    subjectId,
    async (subject) =>
      await listDecisionCitationsHandler({
        subject,
        query: { direction: "incoming", doctrine: "distinguishes" },
      }),
  );

  expect("items" in page).toBe(false);
  if ("items" in page) {
    throw new Error("Expected a doctrine availability refusal");
  }
  expect(page.code).toBe(422);
  expect(page.response.message).toBe("Doctrine filtering is unavailable");
});

test("doctrine citation reads distinguish invalid cursors from unavailable doctrine", async () => {
  const read = async (cursor: string | undefined) =>
    await readGatedDecisionCitations({
      caseLawDb,
      cursor,
      decisionId: subjectId,
      direction: "cited_by",
      doctrine: "distinguishes",
      limit: 1,
      surface: "search",
    });

  expect(await read("not-a-cursor")).toEqual({ type: "invalid_cursor" });

  const differentFilterPage = await withSubject(
    subjectId,
    async (subject) =>
      await listDecisionCitationsHandler({
        subject,
        query: { direction: "incoming", polarity: "negative" },
        limit: 1,
      }),
  );
  if (
    !("items" in differentFilterPage) ||
    differentFilterPage.nextCursor === null
  ) {
    throw new Error("Expected a cursor issued for a different filter");
  }
  expect(await read(differentFilterPage.nextCursor)).toEqual({
    type: "invalid_cursor",
  });
  expect(await read(undefined)).toEqual({ type: "doctrine_unavailable" });
});

test("incoming citations roll up by the citing decision's year within the bounded span", async () => {
  const summary = await withSubject(
    subjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  // Every visible citing row comes from one decision dated 2020.
  expect(summary.incomingByYear).toEqual([{ ...summary.incoming, year: 2020 }]);

  const beyondSpan = await withSubject(
    subjectId,
    async (subject) =>
      await summaryOf({
        currentYear: 2020 + CITATION_TIMELINE_MAX_YEARS,
        subject,
      }),
  );
  expect(beyondSpan.incoming).toEqual(summary.incoming);
  expect(beyondSpan.incomingByYear).toEqual([]);
});

test("citation summary marks the first unseen row without counting it", async () => {
  const cappedSubjectId = createSafeId<"caseLawDecision">();
  // Cites only past the window, with an authority that would lead it.
  const lateCiterId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values([
    {
      caseNumber: "capped-subject",
      country: "CZE",
      court: "Court",
      id: cappedSubjectId,
      language: "cs",
      sourceId: openSourceId,
    },
    {
      caseNumber: "late-citer",
      decisionDate: "2020-01-01",
      citationAuthority: 9,
      country: "CZE",
      court: "Court",
      id: lateCiterId,
      language: "cs",
      sourceId: openSourceId,
    },
  ]);
  const topCitingOf = async () =>
    await withSubject(
      cappedSubjectId,
      async (subject) =>
        await listTopCitingDecisionsHandler({
          subject,
          summary: await summaryOf({ subject }),
          limit: 5,
        }),
    );
  try {
    await db.execute(sql`
      INSERT INTO ${caseLawCitations}
        (id, citing_decision_id, cited_decision_id, citation_text, kind, polarity)
      SELECT
        ('00000000-0000-7000-8000-' || lpad((10000 + n)::text, 12, '0'))::uuid,
        ${openRelatedId}::uuid,
        ${cappedSubjectId}::uuid,
        'summary-bound-' || n::text,
        CASE WHEN n = 1 THEN ${CITATION_KIND.PROCEDURAL} ELSE ${CITATION_KIND.PRECEDENT} END,
        ${POLARITY.POSITIVE}
      FROM generate_series(1, ${CITATION_SUMMARY_SCAN_LIMIT}) AS generated(n)
    `);
    const atLimit = await withSubject(
      cappedSubjectId,
      async (subject) => await summaryOf({ currentYear: 2026, subject }),
    );
    expect(atLimit.precision).toEqual({
      status: "bounded",
      capped: { incoming: false, outgoing: false },
    });
    expect(atLimit.incoming.positive).toBe(CITATION_SUMMARY_SCAN_LIMIT - 1);

    expect((await topCitingOf()).items.map(({ id }) => id)).toEqual([
      openRelatedId,
    ]);

    await db.insert(caseLawCitations).values({
      citedDecisionId: cappedSubjectId,
      citingDecisionId: lateCiterId,
      citationText: "first-unseen-citation",
      id: citationId(10_000 + CITATION_SUMMARY_SCAN_LIMIT + 1),
      polarity: POLARITY.POSITIVE,
    });
    const beyondLimit = await withSubject(
      cappedSubjectId,
      async (subject) => await summaryOf({ currentYear: 2026, subject }),
    );
    expect(beyondLimit.precision).toEqual({
      status: "bounded",
      capped: { incoming: true, outgoing: false },
    });
    expect(beyondLimit.incoming).toEqual(atLimit.incoming);
    expect(beyondLimit.incomingByYear).toEqual(atLimit.incomingByYear);

    await db.execute(
      sql`SELECT refresh_decision_citation_stats(${cappedSubjectId}::uuid)`,
    );
    const exact = await withSubject(
      cappedSubjectId,
      async (subject) => await summaryOf({ currentYear: 2026, subject }),
    );
    expect(exact.precision).toEqual({ status: "exact" });
    expect(exact.incoming.positive).toBe(CITATION_SUMMARY_SCAN_LIMIT);
    expect(exact.incomingByYear).toEqual([{ ...exact.incoming, year: 2020 }]);
    // The top citers come from the counted window too: the decision citing
    // only past it does not lead; ranking precision discloses the window.
    const top = await topCitingOf();
    expect(top).toMatchObject({
      precision: "bounded",
      candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
    });
    expect(top.items.map(({ id }) => id)).toEqual([openRelatedId]);
    await db.insert(caseLawCitations).values({
      citedDecisionId: cappedSubjectId,
      citingDecisionId: lateCiterId,
      citationText: "another-unseen-citation",
      id: citationId(10_000 + CITATION_SUMMARY_SCAN_LIMIT + 2),
      polarity: POLARITY.POSITIVE,
    });
    expect(await topCitingOf()).toMatchObject({
      precision: "bounded",
      candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
    });
    await db
      .delete(caseLawCitations)
      .where(
        inArray(caseLawCitations.id, [
          citationId(10_000 + CITATION_SUMMARY_SCAN_LIMIT + 1),
          citationId(10_000 + CITATION_SUMMARY_SCAN_LIMIT + 2),
        ]),
      );
    const complete = await topCitingOf();
    expect(complete.precision).toBe("exact");
    expect(complete.items.map(({ id }) => id)).toEqual([openRelatedId]);
  } finally {
    await db
      .delete(caseLawCitations)
      .where(eq(caseLawCitations.citedDecisionId, cappedSubjectId));
    await db
      .delete(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, [cappedSubjectId, lateCiterId]));
  }
}, 120_000);

test("an exact projection keeps ranking bounded when procedural edges fill the raw window", async () => {
  const windowSubjectId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    caseNumber: "window-subject",
    country: "CZE",
    court: "Court",
    id: windowSubjectId,
    language: "cs",
    sourceId: openSourceId,
  });
  try {
    // One visible precedent edge behind a full window of procedural ones:
    // the projected total stays far below the window, so only the raw
    // overflow sentinel can tell the ranking it did not see every edge.
    await db.execute(sql`
      INSERT INTO ${caseLawCitations}
        (id, citing_decision_id, cited_decision_id, citation_text, kind, polarity)
      SELECT
        ('00000000-0000-7000-8000-' || lpad((30000 + n)::text, 12, '0'))::uuid,
        ${openRelatedId}::uuid,
        ${windowSubjectId}::uuid,
        'raw-window-' || n::text,
        CASE WHEN n <= ${CITATION_SUMMARY_SCAN_LIMIT} THEN ${CITATION_KIND.PROCEDURAL} ELSE ${CITATION_KIND.PRECEDENT} END,
        ${POLARITY.POSITIVE}
      FROM generate_series(1, ${CITATION_SUMMARY_SCAN_LIMIT + 1}) AS generated(n)
    `);
    await db.execute(
      sql`SELECT refresh_decision_citation_stats(${windowSubjectId}::uuid)`,
    );
    const top = await withSubject(windowSubjectId, async (subject) => {
      const summary = await summaryOf({ currentYear: 2026, subject });
      expect(summary.precision).toEqual({ status: "exact" });
      expect(
        Object.values(summary.incoming).reduce(
          (total, count) => total + count,
          0,
        ),
      ).toBeLessThanOrEqual(CITATION_SUMMARY_SCAN_LIMIT);
      return await listTopCitingDecisionsHandler({
        subject,
        summary,
        limit: 5,
      });
    });
    expect(top).toMatchObject({
      precision: "bounded",
      candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
    });
  } finally {
    await db
      .delete(caseLawCitations)
      .where(eq(caseLawCitations.citedDecisionId, windowSubjectId));
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, windowSubjectId));
  }
}, 120_000);

test("top citing decisions are one row per visible precedent citer", async () => {
  // Fifty-four precedent citations from one decision are one row; the
  // restricted, unavailable and procedural citers are not there at all.
  const top = await withSubject(
    subjectId,
    async (subject) =>
      await listTopCitingDecisionsHandler({
        subject,
        summary: await summaryOf({ subject }),
        limit: 5,
      }),
  );
  expect(top.items.map(({ id }) => id)).toEqual([openRelatedId]);
  expect(top.items.at(0)).toMatchObject({
    caseNumber: "open-related",
    court: "Related court",
    courtAbbreviation: "ÚS",
    sourceUrl: "https://example.test/decision/open-related",
    decisionDate: "2020-02-03",
  });
});

test("a restricted subject decision cannot be resolved as a subject", async () => {
  // The closed decision cites the subject, so it has an outgoing edge that
  // would otherwise be served. The gate answers before any handler runs:
  // without a subject there is no call to make, in either direction.
  expect(
    await withRedistributableSubject(
      caseLawDb,
      "pages",
      {
        kind: "id",
        id: closedRelatedId,
      },
      async () => true,
    ),
  ).toBeNull();
  expect(
    await withRedistributableSubject(
      caseLawDb,
      "pages",
      {
        kind: "id",
        id: subjectId,
      },
      async () => true,
    ),
  ).toBe(true);
});

type RelatedDecisionWithAlternates = {
  id: string;
  languageAlternates: readonly { id: string }[];
} | null;

const thirdLeaderAlternateIds = (
  decisions: readonly RelatedDecisionWithAlternates[],
) =>
  decisions
    .find((decision) => decision?.id === thirdLeaderId)
    ?.languageAlternates.map(({ id }) => id);

test("a listing-only related decision is absent from every citation read even with the highest authority", async () => {
  // The fixture reaches the gate: the listing-only row is otherwise eligible
  // (open source, public country, top authority), and only publication
  // refuses it as a subject of its own.
  expect(
    await withRedistributableSubject(
      caseLawDb,
      "pages",
      { kind: "id", id: listingOnlyRelatedId },
      async () => true,
    ),
  ).toBeNull();

  const listedOrder = RANKED_CITATION_ORDER.filter(
    (id) => id !== listingOnlyRelatedId,
  );
  const leaderOrder = RANKED_LEADERS.map(({ id }) => id);

  for (const direction of CITATION_DIRECTIONS) {
    const page = await withSubject(
      rankedSubjectId,
      async (subject) =>
        await listDecisionCitationsHandler({ subject, query: { direction } }),
    );
    if (!("items" in page)) {
      throw new Error("expected a citation page");
    }
    expect(page.items.map((item) => item.decision?.id)).toEqual(listedOrder);

    const leading = await withSubject(
      rankedSubjectId,
      async (subject) =>
        await listLeadingCitationsHandler({ subject, query: { direction } }),
    );
    expect(leading.items.map((item) => item.decision.id)).toEqual(leaderOrder);
    expect(leading.items.map((item) => item.treatment)).toEqual(
      leaderOrder.map(() => POLARITY.POSITIVE),
    );

    // The third leader shares a language group with a published sibling and
    // the listing-only row: only the sibling is offered as a version.
    for (const alternateIds of [
      thirdLeaderAlternateIds(page.items.map((item) => item.decision)),
      thirdLeaderAlternateIds(leading.items.map((item) => item.decision)),
    ]) {
      expect(alternateIds).toContain(thirdLeaderSiblingId);
      expect(alternateIds).not.toContain(listingOnlyRelatedId);
    }
  }

  // Top citers: by authority, through the same gate, so the listing-only
  // row does not lead however high its authority.
  const top = await withSubject(
    rankedSubjectId,
    async (subject) =>
      await listTopCitingDecisionsHandler({
        subject,
        summary: await summaryOf({ subject }),
        limit: 5,
      }),
  );
  expect(top.items.map(({ id }) => id)).toEqual(leaderOrder);
  expect(thirdLeaderAlternateIds(top.items)).toContain(thirdLeaderSiblingId);

  const summary = await withSubject(
    rankedSubjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(summary.incoming.positive).toBe(RANKED_LEADERS.length);
  expect(summary.outgoing.positive).toBe(RANKED_LEADERS.length);
});

test("listing-only decisions citing or cited do not affect exact public totals", async () => {
  const pending = await withSubject(
    rankedSubjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(pending.precision.status).toBe("bounded");
  expect(pending.incoming.positive).toBe(RANKED_LEADERS.length);
  expect(pending.outgoing.positive).toBe(RANKED_LEADERS.length);
  await db.execute(
    sql`SELECT refresh_decision_citation_stats(${rankedSubjectId}::uuid)`,
  );
  const exact = await withSubject(
    rankedSubjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(exact).toEqual({ ...pending, precision: { status: "exact" } });

  await db
    .update(caseLawDecisions)
    .set({ metadata: null })
    .where(eq(caseLawDecisions.id, listingOnlyRelatedId));
  const published = await withSubject(
    rankedSubjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(published.precision.status).toBe("exact");
  expect(published.incoming.positive).toBe(RANKED_LEADERS.length + 1);
  expect(published.outgoing.positive).toBe(RANKED_LEADERS.length + 1);

  await db
    .update(caseLawDecisions)
    .set({ metadata: LISTING_ONLY_METADATA })
    .where(eq(caseLawDecisions.id, listingOnlyRelatedId));
  const hiddenAgain = await withSubject(
    rankedSubjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(hiddenAgain).toEqual(exact);
});

test("exact citation totals and timeline preserve the public graph filters", async () => {
  const pending = await withSubject(
    subjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(pending.precision).toEqual({
    status: "bounded",
    capped: { incoming: false, outgoing: false },
  });
  await db.execute(
    sql`SELECT refresh_decision_citation_stats(${subjectId}::uuid)`,
  );
  const exact = await withSubject(
    subjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(exact).toEqual({ ...pending, precision: { status: "exact" } });
  const beyondSpan = await withSubject(
    subjectId,
    async (subject) =>
      await summaryOf({
        currentYear: 2020 + CITATION_TIMELINE_MAX_YEARS,
        subject,
      }),
  );
  expect(beyondSpan.precision).toEqual({ status: "exact" });
  expect(beyondSpan.incoming).toEqual(exact.incoming);
  expect(beyondSpan.outgoing).toEqual(exact.outgoing);
  expect(beyondSpan.incomingByYear).toEqual([]);
});

// Last on purpose: it adds a citing decision the page tests above do not
// expect to see.
test("leading citations rank one decision per treatment by authority", async () => {
  const leadId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    caseNumber: "lead",
    citationAuthority: 4.2,
    country: "CZE",
    court: "High court",
    id: leadId,
    language: "cs",
    slug: "lead",
    sourceId: openSourceId,
  });
  await db.insert(caseLawCitations).values({
    citedDecisionId: subjectId,
    citingDecisionId: leadId,
    citationText: "lead-incoming",
    id: citationId(900),
    polarity: POLARITY.NEGATIVE,
  });

  const incoming = await withSubject(
    subjectId,
    async (subject) =>
      await listLeadingCitationsHandler({
        subject,
        query: { direction: "incoming" },
      }),
  );
  // Nine citations from one decision collapse to one row per treatment;
  // the higher authority leads the negative group.
  const byTreatment = new Map<string, string[]>();
  for (const item of incoming.items) {
    const ids = byTreatment.get(item.treatment) ?? [];
    ids.push(item.decision.id);
    byTreatment.set(item.treatment, ids);
  }
  expect(byTreatment.get("negative")).toEqual([leadId, openRelatedId]);
  for (const treatment of CITATION_TREATMENTS) {
    if (treatment === "negative") {
      continue;
    }
    expect(byTreatment.get(treatment)).toEqual([openRelatedId]);
  }
  expect(
    incoming.items.find((item) => item.decision.id === leadId)?.decision
      .citationAuthority,
  ).toBe(4.2);
  expect(
    incoming.items.some((item) => item.citationText === "restricted-incoming"),
  ).toBe(false);

  const outgoing = await withSubject(
    subjectId,
    async (subject) =>
      await listLeadingCitationsHandler({
        subject,
        query: { direction: "outgoing" },
      }),
  );
  expect(outgoing.items.map((item) => item.citationText)).toEqual([
    "outgoing-resolved",
  ]);
});

test("exact empty projections report zero totals without falling back", async () => {
  const emptyId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    caseNumber: "empty-citation-graph",
    country: "CZE",
    court: "Court",
    id: emptyId,
    language: "cs",
    sourceId: openSourceId,
  });
  await db.execute(
    sql`SELECT refresh_decision_citation_stats(${emptyId}::uuid)`,
  );
  const exact = await withSubject(
    emptyId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(exact.precision).toEqual({ status: "exact" });
  expect(Object.values(exact.incoming)).toEqual(
    CITATION_TREATMENTS.map(() => 0),
  );
  expect(Object.values(exact.outgoing)).toEqual(
    CITATION_TREATMENTS.map(() => 0),
  );
  expect(exact.incomingByYear).toEqual([]);
});

test("missing projection column grants preserve bounded summaries", async () => {
  await db.execute(
    sql`SELECT refresh_decision_citation_stats(${subjectId}::uuid)`,
  );
  const exact = await withSubject(
    subjectId,
    async (subject) => await summaryOf({ currentYear: 2026, subject }),
  );
  expect(exact.precision).toEqual({ status: "exact" });
  await db.execute(
    sql`REVOKE SELECT (count) ON case_law_decision_citation_stats FROM stella_public_law_reader`,
  );
  try {
    const bounded = await withSubject(
      subjectId,
      async (subject) => await summaryOf({ currentYear: 2026, subject }),
    );
    const top = await withSubject(
      subjectId,
      async (subject) =>
        await listTopCitingDecisionsHandler({
          subject,
          summary: await summaryOf({ subject }),
          limit: 5,
        }),
    );
    expect(top).toMatchObject({
      precision: "bounded",
      candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
    });
    expect(bounded).toEqual({
      ...exact,
      precision: {
        status: "bounded",
        capped: { incoming: false, outgoing: false },
      },
    });
  } finally {
    await db.execute(
      sql`GRANT SELECT (count) ON case_law_decision_citation_stats TO stella_public_law_reader`,
    );
  }
});

test("exact totals follow source redistribution changes without rebuilding buckets", async () => {
  const read = async () =>
    await withSubject(subjectId, async (subject) =>
      summaryOf({ currentYear: 2026, subject }),
    );
  const before = await read();
  expect(before.precision).toEqual({ status: "exact" });
  const [source] = await db
    .select({ descriptor: caseLawSources.descriptor })
    .from(caseLawSources)
    .where(eq(caseLawSources.id, closedSourceId))
    .limit(1);
  const descriptor =
    source?.descriptor ?? panic("Restricted source descriptor is absent");
  await db
    .update(caseLawSources)
    .set({ descriptor: { ...descriptor, allowsRedistribution: true } })
    .where(eq(caseLawSources.id, closedSourceId));
  try {
    const open = await read();
    expect(open.precision).toEqual({ status: "exact" });
    expect(
      Object.values(open.incoming).reduce((sum, value) => sum + value, 0),
    ).toBe(
      Object.values(before.incoming).reduce((sum, value) => sum + value, 0) + 1,
    );
    expect(
      Object.values(open.outgoing).reduce((sum, value) => sum + value, 0),
    ).toBe(
      Object.values(before.outgoing).reduce((sum, value) => sum + value, 0) + 1,
    );
  } finally {
    await db
      .update(caseLawSources)
      .set({ descriptor })
      .where(eq(caseLawSources.id, closedSourceId));
  }
  expect(await read()).toEqual(before);
});

test("conflicting edge inserts preserve exact projections for both endpoints", async () => {
  const citingId = createSafeId<"caseLawDecision">();
  const citedId = createSafeId<"caseLawDecision">();
  const edgeId = createSafeId<"caseLawCitation">();
  await db.insert(caseLawDecisions).values(
    [citingId, citedId].map((id) => ({
      id,
      caseNumber: id,
      country: "CZE",
      court: "Court",
      language: "cs",
      sourceId: openSourceId,
      decisionDate: "2020-01-01",
    })),
  );
  const edge = {
    id: edgeId,
    citingDecisionId: citingId,
    citedDecisionId: citedId,
    citationText: "conflict-projection",
    kind: CITATION_KIND.PRECEDENT,
    polarity: POLARITY.POSITIVE,
  };
  await db.insert(caseLawCitations).values(edge);
  for (const id of [citingId, citedId]) {
    await db.execute(sql`SELECT refresh_decision_citation_stats(${id}::uuid)`);
  }
  const assertRecount = async () => {
    for (const id of [citingId, citedId]) {
      const actual = await db.execute(sql`
        SELECT direction, related_year, related_country, related_source_id, polarity, count
        FROM case_law_decision_citation_stats WHERE decision_id = ${id}::uuid
        ORDER BY direction, related_year, related_country, related_source_id, polarity`);
      const expected = await db.execute(sql`
        SELECT direction, related_year, related_country, related_source_id, polarity, count
        FROM recount_decision_citation_stats(${id}::uuid)
        ORDER BY direction, related_year, related_country, related_source_id, polarity`);
      expect(expected.rows).toHaveLength(1);
      expect(actual.rows).toEqual(expected.rows);
    }
  };
  await assertRecount();
  await db.insert(caseLawCitations).values(edge).onConflictDoNothing();
  await assertRecount();
  await db
    .insert(caseLawCitations)
    .values(edge)
    .onConflictDoUpdate({
      target: caseLawCitations.id,
      set: { polarity: POLARITY.NEGATIVE },
    });
  await assertRecount();
  await db
    .insert(caseLawCitations)
    .values(edge)
    .onConflictDoUpdate({
      target: caseLawCitations.id,
      set: { polarity: POLARITY.NEGATIVE },
    });
  await assertRecount();
});

test("expand release reports doctrine capability unavailable instead of unread", async () => {
  const page = await readCitationPage("incoming", undefined);
  if (!("items" in page)) {
    throw new Error("Expected a citation page");
  }
  expect(page.doctrineAvailability).toBe("unavailable");
  expect(
    page.items.every(
      ({ doctrine, evidenceQuote }) =>
        doctrine === null && evidenceQuote === null,
    ),
  ).toBe(true);
  const summary = await withSubject(
    subjectId,
    async (subject) => await summarizeDecisionDoctrineHandler({ subject }),
  );
  expect(summary).toEqual({ status: "unavailable" });
});

test("citation digests omit withheld unresolved references", async () => {
  const digest = await readGatedDecisionCitationDigest({
    caseLawDb,
    decisionId: withheldSubjectId,
    surface: "search",
  });
  expect(digest?.cites).toMatchObject([
    {
      citationText: null,
      textWithheldReason: "source_licence",
      decision: null,
    },
  ]);
});

test("citation reads carry withheld text dispositions", async () => {
  const read = await readGatedDecisionCitations({
    caseLawDb,
    cursor: undefined,
    decisionId: withheldSubjectId,
    direction: "cites",
    limit: 10,
    surface: "search",
  });
  expect(read).toMatchObject({
    type: "page",
    page: {
      items: [
        {
          citationText: null,
          textWithheldReason: "source_licence",
          passage: null,
        },
      ],
    },
  });
});

test("citation passages retry when sections replace the AST version they accompany", async () => {
  const citingId = createSafeId<"caseLawDecision">();
  const citedId = createSafeId<"caseLawDecision">();
  const edgeId = createSafeId<"caseLawCitation">();
  const citationText = "21 Cdo 500/2019";
  const oldText = `Old version cites ${citationText}.`;
  const newText = `New version cites ${citationText}.`;
  const astOf = (text: string, anchorId: string): DocumentAst => ({
    version: 1,
    source: { system: "test", documentId: anchorId, webUrl: "", printUrl: "" },
    metadata: {
      caseNumber: "race",
      court: "Court",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        id: anchorId,
        anchorId,
        type: "paragraph",
        inlines: [{ type: "text", text }],
        plainText: text,
      },
    ],
  });
  const oldWarnings = [
    { rule: "html-tag", count: 1, firstOffsets: [0] },
  ] satisfies ExtractionWarnings;
  const newWarnings = [
    { rule: "html-tag", count: 2, firstOffsets: [8, 16] },
  ] satisfies ExtractionWarnings;
  const oldUpdatedAt = new Date("2026-10-01T00:00:00.000Z");
  const newUpdatedAt = new Date("2026-10-02T00:00:00.000Z");
  const newAst = astOf(newText, "new-anchor");
  await db.insert(caseLawDecisions).values([
    {
      id: citingId,
      caseNumber: "racing-citing-decision",
      country: "CZE",
      court: "Court",
      language: "cs",
      sourceId: openSourceId,
      documentAst: astOf(oldText, "old-anchor"),
      sections: [{ index: 0, type: "unknown", title: null, text: oldText }],
      contentHash: "a".repeat(64),
      extractionWarnings: oldWarnings,
      updatedAt: oldUpdatedAt,
    },
    {
      id: citedId,
      caseNumber: "cited-decision",
      country: "CZE",
      court: "Court",
      language: "cs",
      sourceId: openSourceId,
    },
  ]);
  await db.insert(caseLawCitations).values({
    id: edgeId,
    citingDecisionId: citingId,
    citedDecisionId: citedId,
    citationText,
    sectionIndex: 0,
  });

  let transactions = 0;
  const racingDb = Object.assign(
    async <T>(
      read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ): Promise<T> => {
      transactions += 1;
      const result = await caseLawDb(read);
      if (transactions === 2) {
        await db
          .update(caseLawDecisions)
          .set({
            documentAst: newAst,
            sections: [
              { index: 0, type: "unknown", title: null, text: newText },
            ],
            contentHash: "b".repeat(64),
            extractionWarnings: newWarnings,
            updatedAt: newUpdatedAt,
          })
          .where(eq(caseLawDecisions.id, citingId));
      }
      return result;
    },
    caseLawDb,
  );
  const first = await readGatedDecisionCitations({
    caseLawDb: racingDb,
    cursor: undefined,
    decisionId: citingId,
    direction: "cites",
    limit: 10,
    surface: "search",
  });
  expect(first).toMatchObject({
    type: "page",
    page: {
      items: [
        {
          extractionWarnings: newWarnings,
          passage: { anchorId: "new-anchor", text: newText },
        },
      ],
    },
  });
});

test("a reviewed doctrine quote cannot bypass the source text disposition", async () => {
  await db
    .update(caseLawCitations)
    .set({
      citationKey: "doctrine-licence-fixture",
      doctrinalTreatment: "limits",
    })
    .where(eq(caseLawCitations.id, citationId(999)));
  const reviewId = createSafeId<"caseLawCitationDoctrineReview">();
  await db.insert(caseLawCitationDoctrineReviews).values({
    id: reviewId,
    citingDecisionId: withheldSubjectId,
    citationKey: "doctrine-licence-fixture",
    doctrinalTreatment: "limits",
    evidenceQuote: "The earlier precedent has a narrower scope.",
    reviewRef: "test:source-text-disposition",
    origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
  });
  await db.execute(
    sql`GRANT SELECT (citation_key, doctrinal_treatment) ON case_law_citations TO stella_public_law_reader`,
  );
  await db.execute(
    sql`GRANT SELECT (citing_decision_id, citation_key, doctrinal_treatment, evidence_quote) ON case_law_citation_doctrine_reviews TO stella_public_law_reader`,
  );
  const read = await readGatedDecisionCitations({
    caseLawDb,
    cursor: undefined,
    decisionId: withheldSubjectId,
    direction: "cites",
    limit: 10,
    surface: "search",
  });
  const summary = await withSubject(
    withheldSubjectId,
    async (subject) => await summarizeDecisionDoctrineHandler({ subject }),
  );
  await db.execute(
    sql`REVOKE SELECT (citation_key, doctrinal_treatment) ON case_law_citations FROM stella_public_law_reader`,
  );
  await db.execute(
    sql`REVOKE SELECT (citing_decision_id, citation_key, doctrinal_treatment, evidence_quote) ON case_law_citation_doctrine_reviews FROM stella_public_law_reader`,
  );
  await db
    .delete(caseLawCitationDoctrineReviews)
    .where(eq(caseLawCitationDoctrineReviews.id, reviewId));
  await db
    .update(caseLawCitations)
    .set({ citationKey: null, doctrinalTreatment: null })
    .where(eq(caseLawCitations.id, citationId(999)));
  if (read?.type !== "page") {
    throw new Error("Expected a citation page");
  }
  expect(summary).toEqual({
    status: "available",
    counts: {
      incoming: { distinguishes: 0, limits: 0, not_stated: 0, unread: 0 },
      outgoing: { distinguishes: 0, limits: 1, not_stated: 0, unread: 0 },
    },
    capped: { incoming: false, outgoing: false },
    candidateWindow: CITATION_SUMMARY_SCAN_LIMIT,
  });
  expect(read.page.doctrineAvailability).toBe("available");
  expect(read.page.items.at(0)).toMatchObject({
    doctrine: "limits",
    passage: null,
    citationText: null,
    textWithheldReason: "source_licence",
  });
  expect(read.page.items.at(0)).not.toHaveProperty("evidenceQuote");
});
