import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { compareCodeUnit } from "@stll/collation";
import {
  assertProperty,
  propertyConfig,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawStatuteCitationCounts,
  caseLawSources,
  STATUTE_CITATION_TARGET_TYPE,
} from "@/api/db/schema";
import { readStatuteCitationCountsHandler } from "@/api/handlers/case-law/provisions/citation-counts";
import { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const JURISDICTION = "CZE";
/** The display citation a decision's own text states. */
const WORK = "89/2012 Sb.";
const WORK_ELI = "/eli/cz/sb/2012/89";
const REDACTED_WORK = "123/2020 Sb.";
/** A work the corpus does not hold: cited by number, with no ELI to key on. */
const UNHELD_WORK = "99/1963 Sb.";
const ANCHOR_A = "s1";
const ANCHOR_B = "s2";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const highAuthorityId = createSafeId<"caseLawDecision">();
const lowAuthorityId = createSafeId<"caseLawDecision">();
const closedDecisionId = createSafeId<"caseLawDecision">();
const redactedDecisionId = createSafeId<"caseLawDecision">();

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
  ecli: "ECLI:CZ:US:2025:1",
  sourceUrl: `https://example.test/decision/${id}`,
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
      {
        ...decisionRow({
          caseNumber: "redacted",
          citationAuthority: 200,
          decisionDate: "2026-02-01",
          id: redactedDecisionId,
          sourceId: openSourceId,
        }),
        redactedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
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
      provisionRow({
        anchor: ANCHOR_A,
        decisionDate: "2026-02-01",
        decisionId: redactedDecisionId,
        spanStart: 55,
        workEli: null,
        workIdentifier: REDACTED_WORK,
      }),
      provisionRow({
        anchor: ANCHOR_A,
        decisionDate: "2025-01-01",
        decisionId: lowAuthorityId,
        spanStart: 65,
        workEli: null,
        workIdentifier: REDACTED_WORK,
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

const withSubject = async <T>(
  id: SafeId<"caseLawDecision">,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
): Promise<T> =>
  (await withRedistributableSubject(caseLawDb, { kind: "id", id }, read)) ??
  panic("expected a redistributable subject");

const decisionProvisions = async (cursor?: string) => {
  const page = await withSubject(
    highAuthorityId,
    async (subject) =>
      await listDecisionProvisionsHandler({
        subject,
        query: { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
      }),
  );

  if ("items" in page) {
    return page;
  }
  throw new Error("expected a page");
};

type CitingDecisionsQuery = {
  anchor?: string;
  court?: string;
  cursor?: string;
  eli?: string;
  excerpt?: "required";
  limit: number;
  sort?: "authority" | "citations" | "newest";
  year?: number;
  work?: string;
};

const readCitingDecisions = async ({
  anchor,
  court,
  cursor,
  eli,
  excerpt,
  limit,
  sort,
  year,
  work,
}: CitingDecisionsQuery) =>
  await listCitingDecisionsHandler(
    {
      jurisdiction: JURISDICTION,
      limit,
      ...(anchor === undefined ? {} : { anchor }),
      ...(court === undefined ? {} : { court }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(eli === undefined ? {} : { eli }),
      ...(excerpt === undefined ? {} : { excerpt }),
      ...(sort === undefined ? {} : { sort }),
      ...(year === undefined ? {} : { year }),
      ...(work === undefined ? {} : { work }),
    },
    { caseLawDb, courtRegistry: new Map() },
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
  const response = await withSubject(
    highAuthorityId,
    async (subject) =>
      await listDecisionProvisionsHandler({
        subject,
        query: { cursor: "not-a-cursor" },
      }),
  );

  expect("items" in response).toBe(false);
});

test("citing decisions group mentions and order by decision date, newest first", async () => {
  // Authority is refreshed in place and so cannot be a keyset column; it is
  // returned for display only.
  const page = await citingDecisions({ limit: 10 });

  expect(page.items.map((item) => item.caseNumber)).toEqual(["low", "high"]);
  expect(page.items.map((item) => item.mentionCount)).toEqual([1, 3]);
  expect(page.items.map((item) => item.spanStart)).toEqual([40, 10]);
  expect(page.items.at(0)?.decisionDate).toBe("2025-01-01");
  expect(page.items.at(0)?.citationAuthority).toBe(1);
  for (const item of page.items) {
    expect(item.courtAbbreviation).toBe("ÚS");
    expect(item.sourceUrl).toBe(
      `https://example.test/decision/${item.decisionId}`,
    );
  }
  expect(page.items.map((item) => item.versionBasis)).toEqual(
    page.items.map(() => ({ type: "inferred", kind: "decision_date" })),
  );
  expect(page.items.map((item) => item.decisionId)).not.toContain(
    closedDecisionId,
  );
});

test("an unavailable court registry preserves citing decisions without court badges", async () => {
  const page = await listCitingDecisionsHandler(
    { jurisdiction: JURISDICTION, work: WORK, limit: 10 },
    { caseLawDb, courtRegistry: null },
  );
  if (!("items" in page)) {
    panic("Expected citing decisions when the court registry is unavailable");
  }
  expect(page.items.map((item) => item.caseNumber)).toEqual(["low", "high"]);
  for (const item of page.items) {
    expect(item.courtAbbreviation).toBeNull();
    expect(item.courtTier).toBe("other");
  }
});

test("a tombstoned decision keeps its citation edge without its excerpt", async () => {
  const page = await citingDecisions({ limit: 10, work: REDACTED_WORK });

  expect(page.items).toHaveLength(2);
  expect(page.items.at(0)).toMatchObject({
    caseNumber: "redacted",
    decisionId: redactedDecisionId,
    sentenceText: null,
  });
});

test("excerpt-required authority reads fill their budget before limiting", async () => {
  const page = await citingDecisions({
    excerpt: "required",
    limit: 1,
    sort: "authority",
    work: REDACTED_WORK,
  });

  expect(page.items).toHaveLength(1);
  expect(page.items.at(0)).toMatchObject({
    caseNumber: "low",
    sentenceText: `sentence ${ANCHOR_A} 65`,
  });
});

test("citing decisions page through a stable cursor", async () => {
  const seen: { decisionId: string; mentionCount: number }[] = [];
  let cursor: string | undefined;

  for (let request = 0; request < 4; request += 1) {
    const page = await citingDecisions({
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen.push(
      ...page.items.map(({ decisionId, mentionCount }) => ({
        decisionId,
        mentionCount,
      })),
    );
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) {
      break;
    }
  }

  expect(seen).toEqual([
    { decisionId: lowAuthorityId, mentionCount: 1 },
    { decisionId: highAuthorityId, mentionCount: 3 },
  ]);
  expect(cursor).toBeUndefined();
});

test("citing decisions filter by anchor", async () => {
  const page = await citingDecisions({ anchor: ANCHOR_B, limit: 10 });

  expect(page.items.map((item) => item.spanStart)).toEqual([30]);
});

test("citation counts deduplicate repeated mentions by decision", async () => {
  const result = await readStatuteCitationCountsHandler(
    { eli: WORK_ELI, jurisdiction: JURISDICTION },
    caseLawDb,
  );

  expect(result).toEqual({
    status: "ready",
    provisions: [
      { anchor: ANCHOR_A, decisionCount: 2 },
      { anchor: ANCHOR_B, decisionCount: 1 },
    ],
  });
});

test("public readers cannot see restricted-source citation buckets", async () => {
  const rows = await withPublicLawReaderRole(
    db,
    async (tx) =>
      await tx
        .select({
          anchor: caseLawStatuteCitationCounts.anchor,
          decisionCount: caseLawStatuteCitationCounts.decisionCount,
          sourceId: caseLawStatuteCitationCounts.sourceId,
          targetType: caseLawStatuteCitationCounts.targetType,
        })
        .from(caseLawStatuteCitationCounts),
  );

  expect(rows).toHaveLength(3);
  expect(rows.every(({ sourceId }) => sourceId === openSourceId)).toBe(true);
  expect(rows).toContainEqual({
    anchor: "",
    decisionCount: 2,
    sourceId: openSourceId,
    targetType: STATUTE_CITATION_TARGET_TYPE.WORK,
  });
});

test("citing decisions answer the same work by its identifier", async () => {
  // A reader arriving from the act has the work's ELI and no display
  // citation; both keys must reach the same references in the same order.
  const [byWork, byEli] = await Promise.all([
    citingDecisions({ limit: 10 }),
    citingDecisions({ eli: WORK_ELI, limit: 10 }),
  ]);

  expect(
    byEli.items.map(({ decisionId, mentionCount }) => ({
      decisionId,
      mentionCount,
    })),
  ).toEqual(
    byWork.items.map(({ decisionId, mentionCount }) => ({
      decisionId,
      mentionCount,
    })),
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

  expect(second.items).toMatchObject([
    { decisionId: highAuthorityId, mentionCount: 3, spanStart: 10 },
  ]);
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

test("both provision reads preserve applied statements independently of the decision-date candidate", async () => {
  const id = createSafeId<"caseLawDecision">();
  const work = "777/2020 Sb.";
  await db.insert(caseLawDecisions).values(
    decisionRow({
      id,
      caseNumber: "temporal",
      citationAuthority: 1,
      decisionDate: "2020-01-01",
      sourceId: openSourceId,
    }),
  );
  try {
    await db.insert(caseLawProvisionCitations).values([
      {
        ...provisionRow({
          anchor: "par_1",
          decisionDate: "2020-01-01",
          decisionId: id,
          spanStart: 1,
          workIdentifier: work,
        }),
        versionValidFrom: "2020-01-01",
        appliedVersionBasis: "not_stated",
      },
      {
        ...provisionRow({
          anchor: "par_2",
          decisionDate: "2020-01-01",
          decisionId: id,
          spanStart: 20,
          workIdentifier: work,
        }),
        versionValidFrom: "2020-01-01",
        appliedVersionBasis: "stated_date",
        appliedVersionDate: "2013-12-31",
        appliedVersionDateRelation: "until",
        versionEvidenceStart: 30,
        versionEvidenceEnd: 70,
        versionEvidenceKind: "stated_date",
      },
      {
        ...provisionRow({
          anchor: "par_3",
          decisionDate: "2020-01-01",
          decisionId: id,
          spanStart: 80,
          workIdentifier: work,
        }),
        versionValidFrom: "2020-01-01",
        appliedVersionBasis: "stated_version",
        appliedVersionAmendmentWorkIdentifier: "303/2013 Sb.",
        versionEvidenceStart: 90,
        versionEvidenceEnd: 130,
        versionEvidenceKind: "stated_version",
      },
    ]);
    const outgoing = await withSubject(
      id,
      async (subject) =>
        await listDecisionProvisionsHandler({ subject, query: { limit: 10 } }),
    );
    if (!("items" in outgoing)) {
      panic("Expected a provision page");
    }
    const incoming = await citingDecisions({ limit: 10, work });
    expect(outgoing.items.map(({ versionBasis }) => versionBasis)).toEqual([
      { type: "not_stated" },
      {
        type: "stated_date",
        date: "2013-12-31",
        relation: "until",
        expression: null,
        evidence: { kind: "stated_date", start: 30, end: 70 },
      },
      {
        type: "stated_version",
        amendmentWorkIdentifier: "303/2013 Sb.",
        expression: null,
        evidence: { kind: "stated_version", start: 90, end: 130 },
      },
    ]);
    expect(incoming.items).toMatchObject([
      {
        decisionId: id,
        mentionCount: 3,
        spanStart: 1,
        versionBasis: { type: "not_stated" },
      },
    ]);
    expect(
      outgoing.items.map(({ versionValidFrom }) => versionValidFrom),
    ).toEqual([null, null, null]);
    for (const item of [...outgoing.items, ...incoming.items]) {
      expect(item.inferredVersionCandidate).toEqual({
        type: "inferred",
        kind: "decision_date",
        versionValidFrom: "2020-01-01",
      });
    }
  } finally {
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, id));
  }
});

test(
  "newest incoming decision pages preserve date and ID order across filters and count changes",
  async () => {
    await assertProperty(
      "newest incoming decision pages preserve date and ID order across filters and count changes",
      fc.asyncProperty(
        fc.record({
          groupCount: fc.integer({ min: 2, max: 4 }),
          mentionCounts: fc.array(fc.integer({ min: 1, max: 4 }), {
            minLength: 4,
            maxLength: 4,
          }),
          pageSize: fc.integer({ min: 1, max: 4 }),
        }),
        async ({ groupCount, mentionCounts, pageSize }) => {
          const work = `property-${String(createSafeId<"caseLawDecision">())}`;
          const decisions = Array.from(
            { length: groupCount * 2 },
            (_unused, index) => {
              const group = Math.floor(index / 2);
              const year = group < 2 ? 2021 : 2022;
              const mentionCount =
                mentionCounts.at(group) ??
                panic(
                  "Generated mention count is missing for a decision group",
                );
              const decisionId = createSafeId<"caseLawDecision">();
              const court = group % 2 === 0 ? "Court A" : "Court B";
              const decisionDate = `${String(year)}-06-01`;
              return { court, decisionDate, decisionId, mentionCount, year };
            },
          );

          await db.insert(caseLawDecisions).values(
            decisions.map(({ court, decisionDate, decisionId }, index) => ({
              ...decisionRow({
                caseNumber: `${work}-${String(index)}`,
                citationAuthority: index + 1,
                decisionDate,
                id: decisionId,
                sourceId: openSourceId,
              }),
              court,
            })),
          );
          await db.insert(caseLawProvisionCitations).values(
            decisions.flatMap(({ decisionDate, decisionId, mentionCount }) =>
              Array.from({ length: mentionCount }, (_unused, mentionIndex) =>
                provisionRow({
                  anchor: `p${String(mentionIndex + 1)}`,
                  decisionDate,
                  decisionId,
                  spanStart: (mentionIndex + 1) * 10,
                  workEli: null,
                  workIdentifier: work,
                }),
              ),
            ),
          );

          const filters: readonly {
            court: string | undefined;
            year: number | undefined;
          }[] = [
            { court: undefined, year: undefined },
            { court: "Court A", year: undefined },
            { court: "Court B", year: undefined },
            { court: undefined, year: 2021 },
            { court: undefined, year: 2022 },
            { court: "Court A", year: 2021 },
            { court: "Court B", year: 2021 },
            { court: "Court A", year: 2022 },
            { court: "Court B", year: 2022 },
          ];

          for (const filter of filters) {
            const expected = decisions
              .filter(
                (decision) =>
                  (filter.court === undefined ||
                    decision.court === filter.court) &&
                  (filter.year === undefined || decision.year === filter.year),
              )
              .toSorted(
                (left, right) =>
                  compareCodeUnit(right.decisionDate, left.decisionDate) ||
                  compareCodeUnit(
                    String(right.decisionId),
                    String(left.decisionId),
                  ),
              );
            const actual: { decisionId: string; mentionCount: number }[] = [];
            let cursor: string | undefined;

            for (let request = 0; request < 9; request += 1) {
              const page = await citingDecisions({
                limit: pageSize,
                sort: "newest",
                work,
                ...(filter.court === undefined ? {} : { court: filter.court }),
                ...(filter.year === undefined ? {} : { year: filter.year }),
                ...(cursor === undefined ? {} : { cursor }),
              });
              actual.push(
                ...page.items.map(({ decisionId, mentionCount }) => ({
                  decisionId,
                  mentionCount,
                })),
              );
              cursor = page.nextCursor ?? undefined;
              if (cursor === undefined) {
                break;
              }
            }

            expect(cursor).toBeUndefined();
            expect(
              new Set(actual.map(({ decisionId }) => decisionId)).size,
            ).toBe(expected.length);
            expect(actual).toEqual(
              expected.map(({ decisionId, mentionCount }) => ({
                decisionId,
                mentionCount,
              })),
            );
          }

          const first = await citingDecisions({
            limit: 1,
            sort: "newest",
            work,
          });
          const firstItem = first.items.at(0);
          if (firstItem === undefined || first.nextCursor === null) {
            panic("Expected a first keyset page for the generated work");
          }
          const unseenDecision = decisions.find(
            ({ decisionId }) => decisionId !== firstItem.decisionId,
          );
          if (unseenDecision === undefined) {
            panic("Expected an unseen decision after the first page");
          }
          await db.insert(caseLawProvisionCitations).values(
            provisionRow({
              anchor: "citation-insert",
              decisionDate: unseenDecision.decisionDate,
              decisionId: unseenDecision.decisionId,
              spanStart: 1001,
              workEli: null,
              workIdentifier: work,
            }),
          );

          const remaining: string[] = [];
          let cursor: string | undefined = first.nextCursor;
          for (let request = 0; request < 9; request += 1) {
            const page = await citingDecisions({
              cursor,
              limit: pageSize,
              sort: "newest",
              work,
            });
            remaining.push(...page.items.map(({ decisionId }) => decisionId));
            cursor = page.nextCursor ?? undefined;
            if (cursor === undefined) {
              break;
            }
          }
          expect(cursor).toBeUndefined();
          expect([firstItem.decisionId, ...remaining]).toEqual(
            decisions
              .toSorted(
                (left, right) =>
                  compareCodeUnit(right.decisionDate, left.decisionDate) ||
                  compareCodeUnit(
                    String(right.decisionId),
                    String(left.decisionId),
                  ),
              )
              .map(({ decisionId }) => decisionId),
          );
        },
      ),
      propertyConfig({ numRuns: 12 }),
    );
  },
  propertyTestTimeout(60_000),
);

test("citation-count order returns a deterministic capped 200-decision snapshot", async () => {
  const work = `snapshot-${String(createSafeId<"caseLawDecision">())}`;
  const decisions = Array.from({ length: 205 }, (_unused, index) => {
    let mentionCount = 1;
    if (index < 5) {
      mentionCount = 3;
    } else if (index < 15) {
      mentionCount = 2;
    }
    const decisionId = createSafeId<"caseLawDecision">();
    const decisionDate = `202${String(index % 5)}-06-01`;
    return { decisionDate, decisionId, mentionCount };
  });
  await db.insert(caseLawDecisions).values(
    decisions.map(({ decisionDate, decisionId }, index) =>
      decisionRow({
        caseNumber: `snapshot-${String(index)}`,
        citationAuthority: index + 1,
        decisionDate,
        id: decisionId,
        sourceId: openSourceId,
      }),
    ),
  );
  await db.insert(caseLawProvisionCitations).values(
    decisions.flatMap(({ decisionDate, decisionId, mentionCount }) =>
      Array.from({ length: mentionCount }, (_unused, mentionIndex) =>
        provisionRow({
          anchor: `s${String(mentionIndex + 1)}`,
          decisionDate,
          decisionId,
          spanStart: (mentionIndex + 1) * 10,
          workEli: null,
          workIdentifier: work,
        }),
      ),
    ),
  );

  const expected = decisions
    .toSorted(
      (left, right) =>
        right.mentionCount - left.mentionCount ||
        compareCodeUnit(right.decisionDate, left.decisionDate) ||
        compareCodeUnit(String(right.decisionId), String(left.decisionId)),
    )
    .slice(0, 200);
  const page = await citingDecisions({ limit: 1, sort: "citations", work });
  expect(page).toMatchObject({
    limit: 200,
    nextCursor: null,
    snapshot: { limit: 200, type: "capped" },
  });
  expect(page.items).toHaveLength(200);
  expect(
    page.items.map(({ decisionId, mentionCount }) => ({
      decisionId,
      mentionCount,
    })),
  ).toEqual(
    expected.map(({ decisionId, mentionCount }) => ({
      decisionId,
      mentionCount,
    })),
  );
  expect(
    await readCitingDecisions({
      cursor: "not-a-cursor",
      limit: 1,
      sort: "citations",
      work,
    }),
  ).toMatchObject({ code: 400 });
});

test("citation-count order labels a short result complete and other sorts unbounded by snapshot", async () => {
  const page = await citingDecisions({ limit: 1, sort: "citations" });
  expect(page).toMatchObject({
    limit: 200,
    nextCursor: null,
    snapshot: { limit: 200, type: "complete" },
  });
  expect(
    page.items.map(({ decisionId, mentionCount }) => ({
      decisionId,
      mentionCount,
    })),
  ).toEqual([
    { decisionId: highAuthorityId, mentionCount: 3 },
    { decisionId: lowAuthorityId, mentionCount: 1 },
  ]);

  expect(await citingDecisions({ limit: 1, sort: "newest" })).toMatchObject({
    limit: 1,
    snapshot: null,
  });
  expect(await citingDecisions({ limit: 1, sort: "authority" })).toMatchObject({
    limit: 1,
    snapshot: null,
  });
});
