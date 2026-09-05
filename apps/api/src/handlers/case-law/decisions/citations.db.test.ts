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
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
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

const citationId = (value: number): SafeId<"caseLawCitation"> =>
  toSafeId<"caseLawCitation">(
    `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`,
  );

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const withReader = async <T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
): Promise<T> =>
  await withPublicLawReaderRole(
    db,
    async (roleTx) =>
      // SAFETY: the role transaction has the same Drizzle read surface as the
      // public-law handle; writes remain on the owner database above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite test transaction stands in for the public read handle
      await fn(roleTx as unknown as CaseLawPublicReadTransaction),
  );

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

    const restrictedOutgoing = Array.from({ length: 55 }, (_unused, index) => ({
      citedDecisionId: closedRelatedId,
      citingDecisionId: subjectId,
      citationText: `restricted-outgoing-${String(index)}`,
      id: citationId(index),
    }));
    const outgoing = Array.from({ length: 55 }, (_unused, index) => ({
      citedDecisionId: openRelatedId,
      citingDecisionId: subjectId,
      citationText: `outgoing-${String(index)}`,
      id: citationId(100 + index),
    }));
    const restrictedIncoming = Array.from({ length: 55 }, (_unused, index) => ({
      citedDecisionId: subjectId,
      citingDecisionId: closedRelatedId,
      citationText: `restricted-incoming-${String(index)}`,
      id: citationId(200 + index),
    }));
    const incoming = Array.from({ length: 55 }, (_unused, index) => ({
      citedDecisionId: subjectId,
      citingDecisionId: openRelatedId,
      citationText: `incoming-${String(index)}`,
      id: citationId(300 + index),
    }));
    await db.insert(caseLawCitations).values([
      ...restrictedOutgoing,
      ...outgoing,
      ...restrictedIncoming,
      ...incoming,
      {
        citedDecisionId: null,
        citingDecisionId: subjectId,
        citationText: "unresolved",
        id: citationId(155),
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
  const firstOutgoing = await withReader(async (tx) =>
    listOutgoingDecisionCitations({
      tx,
      cursor: undefined,
      decisionId: subjectId,
    }),
  );
  const firstIncoming = await withReader(async (tx) =>
    listIncomingDecisionCitations({
      tx,
      cursor: undefined,
      decisionId: subjectId,
    }),
  );
  if (!("items" in firstOutgoing) || !("items" in firstIncoming)) {
    throw new Error("expected first citation pages");
  }
  expect(firstOutgoing.items).toEqual([]);
  expect(firstOutgoing.nextCursor).not.toBeNull();
  expect(firstIncoming.items).toEqual([]);
  expect(firstIncoming.nextCursor).not.toBeNull();

  const outgoing = await collect(async (cursor) => {
    const page = await withReader(async (tx) =>
      listOutgoingDecisionCitations({
        tx,
        cursor,
        decisionId: subjectId,
      }),
    );
    if (!("items" in page)) {
      throw new Error("expected outgoing page");
    }
    expect(page.items.length).toBeLessThanOrEqual(50);
    return page;
  });
  const incoming = await collect(async (cursor) => {
    const page = await withReader(async (tx) =>
      listIncomingDecisionCitations({
        tx,
        cursor,
        decisionId: subjectId,
      }),
    );
    if (!("items" in page)) {
      throw new Error("expected incoming page");
    }
    expect(page.items.length).toBeLessThanOrEqual(50);
    return page;
  });

  expect(outgoing.items).toHaveLength(56);
  expect(new Set(outgoing.items).size).toBe(56);
  expect(outgoing.items).toContain("unresolved");
  expect(
    outgoing.items.some((item) => item.startsWith("restricted-outgoing-")),
  ).toBe(false);
  expect(outgoing.cursor).toBeUndefined();
  expect(incoming.items).toHaveLength(55);
  expect(new Set(incoming.items).size).toBe(55);
  expect(
    incoming.items.some((item) => item.startsWith("restricted-incoming-")),
  ).toBe(false);
  expect(incoming.cursor).toBeUndefined();
});

test("citation reads reject malformed cursors", async () => {
  const page = await withReader(async (tx) =>
    listOutgoingDecisionCitations({
      tx,
      cursor: "not-a-cursor",
      decisionId: subjectId,
    }),
  );

  expect("items" in page).toBe(false);
});
