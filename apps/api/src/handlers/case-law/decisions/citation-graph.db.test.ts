import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import {
  CITATION_TIMELINE_MAX_YEARS,
  CITATION_TREATMENTS,
  listDecisionCitationsHandler,
  listLeadingCitationsHandler,
  summarizeDecisionCitationsHandler,
  treatmentOf,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type {
  CitationDirection,
  DecisionCitationRow,
} from "@/api/handlers/case-law/decisions/citation-graph";
import { withRedistributableSubject } from "@/api/handlers/case-law/decisions/public-subject";
import type { RedistributableDecisionSubject } from "@/api/handlers/case-law/decisions/public-subject";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const subjectId = createSafeId<"caseLawDecision">();
const openRelatedId = createSafeId<"caseLawDecision">();
const closedRelatedId = createSafeId<"caseLawDecision">();

/** The summary of a visible decision; a 404 here is a test failure. */
const summaryOf = async (
  options: Parameters<typeof summarizeDecisionCitationsHandler>[0],
) => {
  const result = await summarizeDecisionCitationsHandler(options);
  if (!("incoming" in result)) {
    throw new Error("expected a citation summary, got a status response");
  }
  return result;
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
    );
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
    // oxlint-disable-next-line no-await-in-loop -- cursor pages are sequential
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
        item.citationText === "procedural-incoming",
    ),
  ).toBe(false);
  for (const item of incoming.items) {
    expect(item.decision).toEqual({
      id: openRelatedId,
      caseNumber: "open-related",
      country: "CZE",
      court: "Related court",
      decisionDate: "2020-02-03",
      decisionType: "nález",
      ecli: "ECLI:CZ:US:2020:1.US.1.20.2",
      language: "cs",
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
