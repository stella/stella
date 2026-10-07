import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import {
  CITATION_SUMMARY_SCAN_LIMIT,
  CITATION_TIMELINE_MAX_YEARS,
  listDecisionCitationsHandler,
  listLeadingCitationsHandler,
  listTopCitingDecisionsHandler,
  summarizeDecisionCitationsHandler,
  treatmentOf,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type { DecisionCitationRow } from "@/api/handlers/case-law/decisions/citation-graph";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
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
  grantPgliteDecisionCitationStatsReader,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const subjectId = createSafeId<"caseLawDecision">();
const openRelatedId = createSafeId<"caseLawDecision">();
const closedRelatedId = createSafeId<"caseLawDecision">();
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
  expect(Value.Check(citationSummaryResponseSchema, projected)).toBe(true);
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
    await grantPgliteDecisionCitationStatsReader(db);
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
  (await withRedistributableSubject(caseLawDb, { kind: "id", id }, read)) ??
  panic("expected a redistributable subject");

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
