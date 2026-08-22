import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
} from "@/api/db/schema";
import { withRedistributableSubject } from "@/api/handlers/case-law/decisions/public-subject";
import { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const JURISDICTION = "CZE";
/** The display citation a decision's own text states. */
const WORK = "89/2012 Sb.";
const WORK_ELI = "/eli/cz/sb/2012/89";
/** A work the corpus does not hold: cited by number, with no ELI to key on. */
const UNHELD_WORK = "99/1963 Sb.";
const ANCHOR_A = "s1";
const ANCHOR_B = "s2";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const highAuthorityId = createSafeId<"caseLawDecision">();
const lowAuthorityId = createSafeId<"caseLawDecision">();
const closedDecisionId = createSafeId<"caseLawDecision">();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;

const decisionRow = ({
  id,
  caseNumber,
  citationAuthority,
  decisionDate,
  sourceId,
}: {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  citationAuthority: number;
  decisionDate: string | null;
  sourceId: SafeId<"caseLawSource">;
}): typeof caseLawDecisions.$inferInsert => ({
  caseNumber,
  citationAuthority,
  country: JURISDICTION,
  court: "Court",
  decisionDate,
  id,
  language: "cs",
  sourceId,
});

const provisionRow = ({
  anchor,
  decisionDate,
  decisionId,
  spanStart,
  workEli = WORK_ELI,
  workIdentifier = WORK,
}: {
  anchor: string;
  decisionDate: string | null;
  decisionId: SafeId<"caseLawDecision">;
  spanStart: number;
  workEli?: string | null;
  workIdentifier?: string;
}): typeof caseLawProvisionCitations.$inferInsert => ({
  anchor,
  confidence: 0.9,
  decisionDate,
  decisionId,
  jurisdiction: JURISDICTION,
  section: 1,
  sentenceText: `sentence ${anchor} ${String(spanStart)}`,
  spanEnd: spanStart + 10,
  spanStart,
  unit: "section",
  workCollection: "Sb.",
  workEli,
  workIdentifier,
  workNumber: 89,
  workYear: 2012,
});

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      // SAFETY: pglite's drizzle instance satisfies the read surface these
      // handlers use (`select` only).
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
        caseNumber: "high",
        citationAuthority: 9,
        decisionDate: "2024-01-01",
        id: highAuthorityId,
        sourceId: openSourceId,
      }),
      decisionRow({
        caseNumber: "low",
        citationAuthority: 1,
        decisionDate: "2025-01-01",
        id: lowAuthorityId,
        sourceId: openSourceId,
      }),
      decisionRow({
        caseNumber: "closed",
        citationAuthority: 100,
        decisionDate: "2026-01-01",
        id: closedDecisionId,
        sourceId: closedSourceId,
      }),
    ]);

    await db.insert(caseLawProvisionCitations).values([
      provisionRow({
        anchor: ANCHOR_B,
        decisionDate: "2024-01-01",
        decisionId: highAuthorityId,
        spanStart: 30,
      }),
      provisionRow({
        anchor: ANCHOR_A,
        decisionDate: "2024-01-01",
        decisionId: highAuthorityId,
        spanStart: 10,
      }),
      provisionRow({
        anchor: ANCHOR_A,
        decisionDate: "2024-01-01",
        decisionId: highAuthorityId,
        spanStart: 20,
      }),
      provisionRow({
        anchor: ANCHOR_A,
        decisionDate: "2025-01-01",
        decisionId: lowAuthorityId,
        spanStart: 40,
      }),
      provisionRow({
        anchor: ANCHOR_A,
        decisionDate: "2026-01-01",
        decisionId: closedDecisionId,
        spanStart: 50,
      }),
      // Cited by number only: the corpus does not hold this act, so the row
      // carries no ELI and no reader can arrive at it from a statute page.
      provisionRow({
        anchor: ANCHOR_A,
        decisionDate: "2025-01-01",
        decisionId: lowAuthorityId,
        spanStart: 60,
        workEli: null,
        workIdentifier: UNHELD_WORK,
      }),
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const subjectFor = async (id: SafeId<"caseLawDecision">) =>
  (await withRedistributableSubject(
    caseLawDb,
    { kind: "id", id },
    async (subject) => subject,
  )) ?? panic("expected a redistributable subject");

const decisionProvisions = async (cursor?: string) => {
  const page = await listDecisionProvisionsHandler({
    subject: await subjectFor(highAuthorityId),
    query: { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
  });

  if ("items" in page) {
    return page;
  }
  throw new Error("expected a page");
};

type CitingDecisionsQuery = {
  anchor?: string;
  cursor?: string;
  eli?: string;
  limit: number;
  work?: string;
};

const readCitingDecisions = async ({
  anchor,
  cursor,
  eli,
  limit,
  work,
}: CitingDecisionsQuery) =>
  await listCitingDecisionsHandler(
    {
      jurisdiction: JURISDICTION,
      limit,
      ...(anchor === undefined ? {} : { anchor }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(eli === undefined ? {} : { eli }),
      ...(work === undefined ? {} : { work }),
    },
    caseLawDb,
  );

/** Defaults to the display citation, the key a decision's own text states. */
const citingDecisions = async (query: CitingDecisionsQuery) => {
  const page = await readCitingDecisions(
    query.eli === undefined && query.work === undefined
      ? { ...query, work: WORK }
      : query,
  );

  if ("items" in page) {
    return page;
  }
  throw new Error("expected a page");
};

test("decision provisions page by span start", async () => {
  const first = await decisionProvisions();

  expect(first.items.map((item) => item.spanStart)).toEqual([10, 20]);
  expect(first.nextCursor).not.toBeNull();
  expect(first.items[0]?.confidence).toBe(0.9);
  expect(first.items[0]?.sentenceText).toBe(`sentence ${ANCHOR_A} 10`);

  const second = await decisionProvisions(first.nextCursor ?? undefined);

  expect(second.items.map((item) => item.spanStart)).toEqual([30]);
  expect(second.nextCursor).toBeNull();
});

test("decision provisions reject a malformed cursor", async () => {
  const response = await listDecisionProvisionsHandler({
    subject: await subjectFor(highAuthorityId),
    query: { cursor: "not-a-cursor" },
  });

  expect("items" in response).toBe(false);
});

test("citing decisions order by decision date, newest first", async () => {
  // Authority is refreshed in place and so cannot be a keyset column; it is
  // returned for display only.
  const page = await citingDecisions({ limit: 10 });

  expect(page.items.map((item) => item.caseNumber)).toEqual([
    "low",
    "high",
    "high",
    "high",
  ]);
  expect(page.items.at(0)?.decisionDate).toBe("2025-01-01");
  expect(page.items.at(0)?.citationAuthority).toBe(1);
  expect(page.items.map((item) => item.decisionId)).not.toContain(
    closedDecisionId,
  );
});

test("citing decisions page through a stable cursor", async () => {
  const seen: number[] = [];
  let cursor: string | undefined;

  for (let request = 0; request < 4; request += 1) {
    // oxlint-disable-next-line no-await-in-loop -- pagination is sequential by definition
    const page = await citingDecisions({
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.items) {
      seen.push(item.spanStart);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) {
      break;
    }
  }

  expect(seen).toEqual([40, 30, 20, 10]);
  expect(cursor).toBeUndefined();
});

test("citing decisions filter by anchor", async () => {
  const page = await citingDecisions({ anchor: ANCHOR_B, limit: 10 });

  expect(page.items.map((item) => item.spanStart)).toEqual([30]);
});

test("citing decisions answer the same work by its identifier", async () => {
  // A reader arriving from the act has the work's ELI and no display
  // citation; both keys must reach the same references in the same order.
  const [byWork, byEli] = await Promise.all([
    citingDecisions({ limit: 10 }),
    citingDecisions({ eli: WORK_ELI, limit: 10 }),
  ]);

  expect(byEli.items.map((item) => item.spanStart)).toEqual(
    byWork.items.map((item) => item.spanStart),
  );
  expect(byEli.items.length).toBeGreaterThan(0);
});

test("citing decisions by identifier filter by anchor and page alike", async () => {
  const anchored = await citingDecisions({
    anchor: ANCHOR_B,
    eli: WORK_ELI,
    limit: 10,
  });

  expect(anchored.items.map((item) => item.spanStart)).toEqual([30]);

  const first = await citingDecisions({ eli: WORK_ELI, limit: 1 });

  expect(first.nextCursor).not.toBeNull();

  const second = await citingDecisions({
    eli: WORK_ELI,
    limit: 1,
    ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
  });

  expect(second.items.map((item) => item.spanStart)).toEqual([30]);
});

test("a reference to a work the corpus does not hold is reachable only by number", async () => {
  const byWork = await citingDecisions({ limit: 10, work: UNHELD_WORK });

  // The fixture states this reference, so an empty answer below is the ELI
  // key excluding it rather than the row being absent.
  expect(byWork.items.map((item) => item.spanStart)).toEqual([60]);

  const byEli = await citingDecisions({ eli: WORK_ELI, limit: 10 });

  expect(byEli.items.map((item) => item.spanStart)).not.toContain(60);
});

test("citing decisions refuse a request that names neither key or both", async () => {
  const neither = await readCitingDecisions({ limit: 10 });
  const both = await readCitingDecisions({
    eli: WORK_ELI,
    limit: 10,
    work: WORK,
  });

  // The status and the message are the contract a caller reads: an unrelated
  // failure would also leave `items` absent.
  expect(neither).toMatchObject({
    code: 400,
    response: { message: "Name exactly one of work or eli" },
  });
  expect(both).toMatchObject({
    code: 400,
    response: { message: "Name exactly one of work or eli" },
  });
});
