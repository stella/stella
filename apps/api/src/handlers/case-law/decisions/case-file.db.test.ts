import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { listCaseFileDocuments } from "@/api/handlers/case-law/decisions/case-file";
import { citationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { LIMITS } from "@/api/lib/limits";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

let client: PGlite;
const sourceId = createSafeId<"caseLawSource">();
const otherSourceId = createSafeId<"caseLawSource">();
const restrictedSourceId = createSafeId<"caseLawSource">();
const ungroupedId = createSafeId<"caseLawDecision">();
const subject = {
  caseNumber: "8 As 123/2020",
  caseNumberType: "case-number",
  country: "CZE",
  court: "Court of Justice",
  courtId: null,
  sourceId,
  language: "en",
  languageGroupKey: "file-judgment",
} as const;

// timeout: boots the PGlite engine with the full schema and seeds a full case-file page before assertions.
beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  await db.insert(caseLawSources).values([
    caseLawSourceRow({ id: sourceId, adapterKey: "file-open", name: "Open" }),
    caseLawSourceRow({
      id: otherSourceId,
      adapterKey: "file-other",
      name: "Other",
    }),
    caseLawSourceRow({
      id: restrictedSourceId,
      adapterKey: "file-restricted",
      name: "Restricted",
      descriptor: {
        allowsDerivedAi: false,
        allowsRedistribution: false,
        attribution: "Publisher",
        license: "restricted",
      },
    }),
  ]);
  const base = { ...subject, citationKey: citationKeyOf(subject.caseNumber) };
  await db.insert(caseLawDecisions).values(
    [
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        decisionType: "judgment",
        decisionDate: "2020-10-01",
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        court: "Cour de justice",
        language: "fr",
        decisionType: "judgment",
        decisionDate: "2020-10-01",
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: "file-opinion",
        court: "Cour de justice",
        language: "fr",
        decisionType: "opinion",
        decisionDate: "2020-03-01",
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: "file-opinion",
        decisionType: "opinion",
        decisionDate: "2020-03-01",
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: "other-court",
        court: "General Court",
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: "other-source",
        sourceId: otherSourceId,
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: "restricted",
        sourceId: restrictedSourceId,
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: "redacted",
        redactedAt: new Date("2020-01-01"),
      },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: "listing",
        metadata: {
          [PARTIAL_OBSERVATION_KEY]: {
            [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
          },
        },
      },
      { ...base, id: ungroupedId, languageGroupKey: null },
      {
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: ungroupedId,
      },
      ...Array.from({ length: LIMITS.caseLawCaseFilePageSize }, (_, index) => ({
        ...base,
        id: createSafeId<"caseLawDecision">(),
        languageGroupKey: `order-${String(index).padStart(3, "0")}`,
        decisionType: "order",
      })),
    ].map((row, index) => ({
      ...row,
      sourceDocumentId: `file-document-${String(index)}`,
    })),
  );
}, 120_000);

afterAll(async () => {
  await client.close();
});

const readPage = async (cursor?: string | null) =>
  await withPublicLawReaderRole(
    drizzle({ client }),
    async (tx) =>
      await listCaseFileDocuments({ tx, decision: subject, cursor }),
  );

test("case file collapses languages and pages every document without crossing courts or publication gates", async () => {
  const first = await readPage();
  if (first === false) {
    throw new TypeError("Valid first page was rejected");
  }
  expect(first.items).toHaveLength(LIMITS.caseLawCaseFilePageSize);
  expect(first.nextCursor).not.toBeNull();
  const second = await readPage(first.nextCursor);
  if (second === false) {
    throw new TypeError("Issued cursor was rejected");
  }
  expect(second.nextCursor).toBeNull();
  const items = [...first.items, ...second.items];
  expect(items).toHaveLength(LIMITS.caseLawCaseFilePageSize + 5);
  expect(new Set(items.map((item) => item.languageGroupKey)).size).toBe(
    items.length,
  );
  // A case file is one docket in one court, whichever redistributable source
  // published each document; another court, a restricted source, and rows the
  // published view hides (redacted, listing-only) stay out.
  const documentGroups = items
    .map(({ languageGroupKey }) => languageGroupKey)
    .filter((key) => key === null || !key.startsWith("order-"));
  expect(documentGroups).toHaveLength(5);
  expect(documentGroups).toEqual(
    expect.arrayContaining([
      "file-judgment",
      "file-opinion",
      "other-source",
      ungroupedId,
      null,
    ]),
  );
  expect(items.some((item) => item.id === ungroupedId)).toBe(true);
  expect(items.some((item) => item.languageGroupKey === ungroupedId)).toBe(
    true,
  );
  expect(items.every((item) => item.language === "en")).toBe(true);
  expect(items.filter((item) => item.decisionType === "judgment")).toHaveLength(
    1,
  );
  expect(items.filter((item) => item.decisionType === "opinion")).toHaveLength(
    1,
  );
  expect(items.filter((item) => item.decisionType === "order")).toHaveLength(
    LIMITS.caseLawCaseFilePageSize,
  );
  const judgment = items.find((item) => item.decisionType === "judgment");
  expect(judgment?.languageAlternates.map((item) => item.language)).toEqual([
    "en",
    "fr",
  ]);
});
