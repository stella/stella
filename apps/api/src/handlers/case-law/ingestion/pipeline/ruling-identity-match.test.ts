import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { docketFamilyKeyOf } from "@stll/api-contract/decision-docket-reference";
import { assertProperty } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import { listAdapterKeys } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { recordSourceIdentityRaw } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { findRepublishedRulingTx } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  matchRepublishedRuling,
  REPUBLISHED_RULING_OUTCOME,
  REPUBLISHED_RULING_PARTIAL_REASON,
} from "./ruling-identity-match";

const complete = {
  country: "PL",
  courtId: "pl:nsa",
  caseNumber: "II OSK 123/24",
  decisionDate: "2024-06-03",
  decisionType: "wyrok",
} as const;

const stored = [{ decisionId: "canonical", identity: complete }];

describe("cross-source ruling identity", () => {
  test("all registered source pairs converge on the same complete identity", async () => {
    await assertProperty(
      "republished ruling identity converges across registered source pairs",
      fc.property(
        fc.constantFrom(...listAdapterKeys()),
        fc.constantFrom(...listAdapterKeys()),
        (sourceA, sourceB) => {
          fc.pre(sourceA !== sourceB);
          const first = matchRepublishedRuling(complete, stored);
          const replay = matchRepublishedRuling(complete, stored);
          expect({ sourceA, sourceB, first, replay }).toEqual({
            sourceA,
            sourceB,
            first: {
              type: REPUBLISHED_RULING_OUTCOME.LINKED,
              decisionId: "canonical",
            },
            replay: {
              type: REPUBLISHED_RULING_OUTCOME.LINKED,
              decisionId: "canonical",
            },
          });
        },
      ),
    );
  });
  test("links only one complete matching ruling", () => {
    expect(matchRepublishedRuling(complete, stored)).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.LINKED,
      decisionId: "canonical",
    });
  });

  test("an absent date never links", () => {
    expect(
      matchRepublishedRuling({ ...complete, decisionDate: undefined }, stored),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.DATE_ABSENT,
    });
  });

  test("a different date stays separate", () => {
    expect(
      matchRepublishedRuling(
        { ...complete, decisionDate: "2024-06-04" },
        stored,
      ),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.DATE_DIFFERS,
    });
  });

  test("a different type stays separate", () => {
    expect(
      matchRepublishedRuling({ ...complete, decisionType: "uchwała" }, stored),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.TYPE_DIFFERS,
    });
  });

  test("multiple complete matches are ambiguous", () => {
    expect(
      matchRepublishedRuling(complete, [
        ...stored,
        { decisionId: "other", identity: complete },
      ]),
    ).toEqual({ type: REPUBLISHED_RULING_OUTCOME.SEPARATE_AMBIGUOUS });
  });
});

describe("cross-source ruling identity lookup", () => {
  let client: Awaited<ReturnType<typeof createTestPglite>>;
  let db: ReturnType<typeof drizzle>;
  const sources = Array.from({ length: 20 }, () =>
    createSafeId<"caseLawSource">(),
  );
  const sourceAt = (index: number) => {
    const source = sources.at(index);
    if (source === undefined) {
      throw new Error("Identity source fixture is absent");
    }
    return source;
  };
  const registeredSourceIds = new Map(
    listAdapterKeys().map((key) => [key, createSafeId<"caseLawSource">()]),
  );
  const observed = plainTextIngestionResult({
    country: "POL",
    court: "Naczelny Sąd Administracyjny",
    language: "pl",
    caseNumber: "II OSK 123/24",
    decisionDate: "2024-06-03",
    decisionType: "wyrok",
    fulltext: "Sentencja",
    rawHash: "lookup-observation",
    documentAst: EMPTY_AST,
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });

  beforeAll(
    async () => {
      client = await createTestPglite();
      db = drizzle({ client });
      await db.insert(caseLawSources).values([
        ...sources.map((id, index) => ({
          id,
          adapterKey: `identity-source-${String(index)}`,
          name: `Identity source ${String(index)}`,
        })),
        ...[...registeredSourceIds].map(([adapterKey, id]) => ({
          id,
          adapterKey,
          name: `Registered source ${adapterKey}`,
        })),
      ]);
    },
    { timeout: 120_000 },
  );

  afterAll(async () => await client.close());

  test("court identity filters more than sixteen unrelated names before the bound", async () => {
    const matchingDecisionId = createSafeId<"caseLawDecision">();
    const decisionIds = [
      ...Array.from({ length: 17 }, () => createSafeId<"caseLawDecision">()),
      matchingDecisionId,
    ];
    const docketFamilyKey = docketFamilyKeyOf(
      observed.caseNumber,
      observed.country,
    );
    await db.insert(caseLawDecisions).values(
      decisionIds.map((id, index) => ({
        id,
        sourceId: sourceAt(index + 1),
        sourceDocumentId: `court-name-${String(index)}`,
        country: observed.country,
        court:
          index === decisionIds.length - 1
            ? observed.court
            : `Unrelated court ${String(index)}`,
        language: observed.language,
        caseNumber: observed.caseNumber,
        docketFamilyKey,
        decisionDate: observed.decisionDate,
        decisionType: observed.decisionType,
      })),
    );

    expect(
      await db.transaction(
        async (tx) =>
          await findRepublishedRulingTx(
            asTestRaw<Transaction>(tx),
            observed,
            sourceAt(0),
          ),
      ),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.LINKED,
      decisionId: matchingDecisionId,
    });
  });

  test("equal court ids link publications with different court labels", async () => {
    const canonicalId = createSafeId<"caseLawDecision">();
    const caseNumber = "21-123";
    await db.insert(caseLawDecisions).values({
      id: canonicalId,
      sourceId: sourceAt(1),
      sourceDocumentId: "court-id-canonical",
      country: "USA",
      court: "Supreme Court of the United States",
      courtId: "scotus",
      language: observed.language,
      caseNumber,
      docketFamilyKey: docketFamilyKeyOf(caseNumber, "USA"),
      decisionDate: observed.decisionDate,
      decisionType: observed.decisionType,
    });

    expect(
      await db.transaction(
        async (tx) =>
          await findRepublishedRulingTx(
            asTestRaw<Transaction>(tx),
            plainTextIngestionResult({
              ...observed,
              country: "USA",
              court: "United States Supreme Court",
              courtId: "scotus",
              caseNumber,
              sourceDocumentId: "court-id-republication",
              rawHash: "court-id-republication",
            }),
            sourceAt(0),
          ),
      ),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.LINKED,
      decisionId: canonicalId,
    });
  });

  test("raw provenance updates only the observed publisher identity", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const sourceId = sourceAt(1);
    await db.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      sourceDocumentId: "first-document",
      country: "POL",
      court: observed.court,
      language: observed.language,
      caseNumber: "RAW 1/26",
      docketFamilyKey: docketFamilyKeyOf("RAW 1/26", "POL"),
    });
    await db.insert(caseLawDecisionSourceIdentities).values([
      {
        sourceId,
        sourceDocumentId: "first-document",
        decisionId,
        sourceRawS3Key: "raw/first/original",
      },
      {
        sourceId,
        sourceDocumentId: "second-document",
        decisionId,
        sourceRawS3Key: "raw/second/original",
      },
    ]);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));

    await recordSourceIdentityRaw({
      scopedDb,
      sourceId,
      decisionId,
      sourceDocumentId: "second-document",
      rawArtifact: {
        sourceRawS3Key: "raw/second/updated",
        sourceRawContentType: "application/json",
      },
      sourceUrl: "https://example.invalid/second",
      observedAt: new Date("2026-10-20T00:00:00Z"),
    });

    expect(
      await db
        .select({
          sourceDocumentId: caseLawDecisionSourceIdentities.sourceDocumentId,
          sourceRawS3Key: caseLawDecisionSourceIdentities.sourceRawS3Key,
        })
        .from(caseLawDecisionSourceIdentities)
        .where(eq(caseLawDecisionSourceIdentities.decisionId, decisionId))
        .orderBy(caseLawDecisionSourceIdentities.sourceDocumentId),
    ).toEqual([
      {
        sourceDocumentId: "first-document",
        sourceRawS3Key: "raw/first/original",
      },
      {
        sourceDocumentId: "second-document",
        sourceRawS3Key: "raw/second/updated",
      },
    ]);
  });

  test("republished ruling ingestion persists cross-source identity invariants", async () => {
    let example = 0;
    await assertProperty(
      "republished ruling ingestion persists cross-source identity invariants",
      fc.asyncProperty(
        fc.constantFrom(...listAdapterKeys()),
        fc.constantFrom(...listAdapterKeys()),
        async (adapterA, adapterB) => {
          fc.pre(adapterA !== adapterB);
          const sourceA = registeredSourceIds.get(adapterA);
          const sourceB = registeredSourceIds.get(adapterB);
          if (sourceA === undefined || sourceB === undefined) {
            throw new Error("Registered adapter source fixture is absent");
          }
          example++;
          const caseNumber = `P ${String(example)}/2026`;
          const identity = plainTextIngestionResult({
            ...observed,
            caseNumber,
            sourceDocumentId: `a-${String(example)}`,
            rawHash: `a-${String(example)}`,
          });
          const canonicalId = createSafeId<"caseLawDecision">();
          await db.insert(caseLawDecisions).values({
            id: canonicalId,
            sourceId: sourceA,
            sourceDocumentId: identity.sourceDocumentId,
            country: identity.country,
            court: identity.court,
            language: identity.language,
            caseNumber,
            docketFamilyKey: docketFamilyKeyOf(caseNumber, identity.country),
            decisionDate: identity.decisionDate,
            decisionType: identity.decisionType,
          });
          await db.insert(caseLawDecisionSourceIdentities).values({
            sourceId: sourceA,
            sourceDocumentId: identity.sourceDocumentId,
            decisionId: canonicalId,
            sourceRawS3Key: `raw/${adapterA}/${String(example)}`,
          });

          const republished = plainTextIngestionResult({
            ...identity,
            sourceDocumentId: `b-${String(example)}`,
            rawHash: `b-${String(example)}`,
          });
          expect(
            await db.transaction(
              async (tx) =>
                await findRepublishedRulingTx(
                  asTestRaw<Transaction>(tx),
                  republished,
                  sourceB,
                ),
            ),
          ).toEqual({
            type: REPUBLISHED_RULING_OUTCOME.LINKED,
            decisionId: canonicalId,
          });
          await db
            .insert(caseLawDecisionSourceIdentities)
            .values({
              sourceId: sourceB,
              sourceDocumentId: republished.sourceDocumentId,
              decisionId: canonicalId,
              sourceRawS3Key: `raw/${adapterB}/${String(example)}`,
            })
            .onConflictDoNothing();
          await db
            .insert(caseLawDecisionSourceIdentities)
            .values({
              sourceId: sourceB,
              sourceDocumentId: republished.sourceDocumentId,
              decisionId: canonicalId,
              sourceRawS3Key: `raw/${adapterB}/${String(example)}`,
            })
            .onConflictDoNothing();

          const storedIdentities = await db
            .select()
            .from(caseLawDecisionSourceIdentities)
            .where(eq(caseLawDecisionSourceIdentities.decisionId, canonicalId))
            .orderBy(caseLawDecisionSourceIdentities.sourceId);
          expect(storedIdentities).toHaveLength(2);
          expect(
            storedIdentities.find(({ sourceId }) => sourceId === sourceB),
          ).toMatchObject({
            decisionId: canonicalId,
            sourceRawS3Key: `raw/${adapterB}/${String(example)}`,
          });

          const variants = [
            ["date", { decisionDate: "2024-06-04" }],
            ["type", { decisionType: "postanowienie" }],
          ] satisfies readonly (readonly [
            string,
            { decisionDate: string } | { decisionType: string },
          ])[];
          for (const [suffix, variant] of variants) {
            const changed = plainTextIngestionResult({
              ...republished,
              ...variant,
              sourceDocumentId: `${suffix}-${String(example)}`,
              rawHash: `${suffix}-${String(example)}`,
            });
            const outcome = await db.transaction(
              async (tx) =>
                await findRepublishedRulingTx(
                  asTestRaw<Transaction>(tx),
                  changed,
                  sourceB,
                ),
            );
            expect(outcome.type).toBe(
              REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
            );
            await db.insert(caseLawDecisions).values({
              id: createSafeId<"caseLawDecision">(),
              sourceId: sourceB,
              sourceDocumentId: changed.sourceDocumentId,
              country: changed.country,
              court: changed.court,
              language: changed.language,
              caseNumber,
              docketFamilyKey: docketFamilyKeyOf(caseNumber, changed.country),
              decisionDate: changed.decisionDate,
              decisionType: changed.decisionType,
            });
          }
          expect(
            await db
              .select()
              .from(caseLawDecisions)
              .where(
                and(
                  eq(caseLawDecisions.caseNumber, caseNumber),
                  eq(caseLawDecisions.court, identity.court),
                ),
              ),
          ).toHaveLength(3);
          const undated = plainTextIngestionResult({
            ...republished,
            decisionDate: undefined,
            sourceDocumentId: `undated-${String(example)}`,
            rawHash: `undated-${String(example)}`,
          });
          expect(
            await db.transaction(
              async (tx) =>
                await findRepublishedRulingTx(
                  asTestRaw<Transaction>(tx),
                  undated,
                  sourceB,
                ),
            ),
          ).toEqual({
            type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
            reason: REPUBLISHED_RULING_PARTIAL_REASON.DATE_ABSENT,
          });
          await db.insert(caseLawDecisions).values({
            id: createSafeId<"caseLawDecision">(),
            sourceId: sourceB,
            sourceDocumentId: undated.sourceDocumentId,
            country: undated.country,
            court: undated.court,
            language: undated.language,
            caseNumber,
            docketFamilyKey: docketFamilyKeyOf(caseNumber, undated.country),
            decisionType: undated.decisionType,
          });
          expect(
            await db
              .select()
              .from(caseLawDecisions)
              .where(
                and(
                  eq(caseLawDecisions.caseNumber, caseNumber),
                  eq(caseLawDecisions.court, identity.court),
                ),
              ),
          ).toHaveLength(4);
        },
      ),
      { numRuns: 8 },
    );
  });
});
