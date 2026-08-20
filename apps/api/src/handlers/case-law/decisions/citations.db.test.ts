import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  listIncomingDecisionCitations,
  listOutgoingDecisionCitations,
} from "@/api/handlers/case-law/decisions/citations";
import { createSafeId } from "@/api/lib/branded-types";
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

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;

const decisionRow = ({
  caseNumber,
  id,
  sourceId,
}: {
  caseNumber: string;
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
}): typeof caseLawDecisions.$inferInsert => ({
  caseNumber,
  country: "CZE",
  court: "Court",
  id,
  language: "cs",
  sourceId,
});

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
      decisionRow({
        caseNumber: "subject",
        id: subjectId,
        sourceId: openSourceId,
      }),
      decisionRow({
        caseNumber: "open-related",
        id: openRelatedId,
        sourceId: openSourceId,
      }),
      decisionRow({
        caseNumber: "closed-related",
        id: closedRelatedId,
        sourceId: closedSourceId,
      }),
    ]);

    const outgoing = Array.from({ length: 55 }, (_unused, index) => ({
      citedDecisionId: openRelatedId,
      citingDecisionId: subjectId,
      citationText: `outgoing-${String(index)}`,
      id: createSafeId<"caseLawCitation">(),
    }));
    const incoming = Array.from({ length: 55 }, (_unused, index) => ({
      citedDecisionId: subjectId,
      citingDecisionId: openRelatedId,
      citationText: `incoming-${String(index)}`,
      id: createSafeId<"caseLawCitation">(),
    }));
    await db.insert(caseLawCitations).values([
      ...outgoing,
      ...incoming,
      {
        citedDecisionId: null,
        citingDecisionId: subjectId,
        citationText: "unresolved",
        id: createSafeId<"caseLawCitation">(),
      },
      {
        citedDecisionId: closedRelatedId,
        citingDecisionId: subjectId,
        citationText: "restricted-target",
        id: createSafeId<"caseLawCitation">(),
      },
      {
        citedDecisionId: subjectId,
        citingDecisionId: closedRelatedId,
        citationText: "restricted-source",
        id: createSafeId<"caseLawCitation">(),
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const collect = async (
  readPage: (cursor: string | undefined) => Promise<{
    items: { citationText: string }[];
    nextCursor: string | null;
  }>,
) => {
  const items: string[] = [];
  let cursor: string | undefined;

  for (let request = 0; request < 3; request += 1) {
    // oxlint-disable-next-line no-await-in-loop -- cursor pages are sequential
    const page = await readPage(cursor);
    items.push(...page.items.map((item) => item.citationText));
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) {
      break;
    }
  }

  return { cursor, items };
};

test("citation reads traverse bounded pages without leaking restricted decisions", async () => {
  const outgoing = await collect(async (cursor) => {
    const page = await listOutgoingDecisionCitations({
      caseLawDb,
      cursor,
      decisionId: subjectId,
    });
    if (!("items" in page)) {
      throw new Error("expected outgoing page");
    }
    expect(page.items.length).toBeLessThanOrEqual(50);
    return page;
  });
  const incoming = await collect(async (cursor) => {
    const page = await listIncomingDecisionCitations({
      caseLawDb,
      cursor,
      decisionId: subjectId,
    });
    if (!("items" in page)) {
      throw new Error("expected incoming page");
    }
    expect(page.items.length).toBeLessThanOrEqual(50);
    return page;
  });

  expect(outgoing.items).toHaveLength(56);
  expect(new Set(outgoing.items).size).toBe(56);
  expect(outgoing.items).toContain("unresolved");
  expect(outgoing.items).not.toContain("restricted-target");
  expect(outgoing.cursor).toBeUndefined();
  expect(incoming.items).toHaveLength(55);
  expect(new Set(incoming.items).size).toBe(55);
  expect(incoming.items).not.toContain("restricted-source");
  expect(incoming.cursor).toBeUndefined();
});

test("citation reads reject malformed cursors", async () => {
  const page = await listOutgoingDecisionCitations({
    caseLawDb,
    cursor: "not-a-cursor",
    decisionId: subjectId,
  });

  expect("items" in page).toBe(false);
});
