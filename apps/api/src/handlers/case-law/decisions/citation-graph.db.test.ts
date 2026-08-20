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
  summarizeDecisionCitationsHandler,
  treatmentOf,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type {
  CitationDirection,
  DecisionCitationRow,
} from "@/api/handlers/case-law/decisions/citation-graph";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const subjectId = createSafeId<"caseLawDecision">();
const openRelatedId = createSafeId<"caseLawDecision">();
const closedRelatedId = createSafeId<"caseLawDecision">();

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
      // SAFETY: pglite's drizzle instance satisfies the select-only read surface.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded test database stands in for the read handle
      await fn(db as unknown as CaseLawPublicReadTransaction);
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

const collect = async (direction: CitationDirection) => {
  const items: DecisionCitationRow[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (let request = 0; request < 4; request += 1) {
    // oxlint-disable-next-line no-await-in-loop -- cursor pages are sequential
    const page = await listDecisionCitationsHandler({
      caseLawDb,
      decisionId: subjectId,
      query: { direction, ...(cursor === undefined ? {} : { cursor }) },
    });
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
      language: "cs",
      slug: "open-related",
    });
  }

  const counted = new Map<string, number>();
  for (const item of incoming.items) {
    counted.set(item.treatment, (counted.get(item.treatment) ?? 0) + 1);
  }
  const summary = await summarizeDecisionCitationsHandler({
    caseLawDb,
    decisionId: subjectId,
  });
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

  const summary = await summarizeDecisionCitationsHandler({
    caseLawDb,
    decisionId: subjectId,
  });
  expect(summary.outgoing).toEqual({
    negative: 0,
    neutral: 0,
    positive: 1,
    supportive: 0,
    unclassified: 1,
  });
});

test("citation pages reject malformed cursors", async () => {
  const page = await listDecisionCitationsHandler({
    caseLawDb,
    decisionId: subjectId,
    query: { cursor: "not-a-cursor", direction: "incoming" },
  });

  expect("items" in page).toBe(false);
});

test("incoming citations roll up by the citing decision's year within the bounded span", async () => {
  const summary = await summarizeDecisionCitationsHandler({
    caseLawDb,
    currentYear: 2026,
    decisionId: subjectId,
  });
  // Every visible citing row comes from one decision dated 2020.
  expect(summary.incomingByYear).toEqual([{ ...summary.incoming, year: 2020 }]);

  const beyondSpan = await summarizeDecisionCitationsHandler({
    caseLawDb,
    currentYear: 2020 + CITATION_TIMELINE_MAX_YEARS,
    decisionId: subjectId,
  });
  expect(beyondSpan.incoming).toEqual(summary.incoming);
  expect(beyondSpan.incomingByYear).toEqual([]);
});
