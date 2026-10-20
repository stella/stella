import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { docketFamilyKeyOf } from "@stll/api-contract/decision-docket-reference";
import { assertProperty } from "@stll/property-testing";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import { listAdapterKeys } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  processDecision,
  recordSourceIdentityRaw,
} from "@/api/handlers/case-law/ingestion/pipeline/decision";
import {
  findRepublishedRulingTx,
  observeDecision,
  resolveDecisionIdentityTx,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { STATED_ECLI_IDENTITY } from "@/api/lib/legal-search/adapter-manifest";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
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
  test("all registered source pairs converge on the same complete identity", () => {
    assertProperty(
      "all registered source pairs converge on the same complete identity",
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
  const connect = (database: Awaited<ReturnType<typeof createTestPglite>>) =>
    drizzle({
      client: database,
      relations: { ...relations, ...authRelationsPart },
    });
  let db: ReturnType<typeof connect>;
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
      db = connect(client);
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
      observationOrder: 1n,
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

  test("an ECLI conflict never takes the republished-link path", async () => {
    const sourceId = sourceAt(0);
    const otherSourceId = sourceAt(1);
    const caseNumber = "ECLI CONFLICT 1/26";
    const ecli = "ECLI:PL:NSA:2026:CONFLICT";
    const input = plainTextIngestionResult({
      ...observed,
      caseNumber,
      ecli,
      sourceDocumentId: "ecli-conflict-incoming",
      rawHash: "ecli-conflict-incoming",
    });
    const values = [
      { sourceId, sourceDocumentId: "ecli-conflict-a" },
      { sourceId, sourceDocumentId: "ecli-conflict-b" },
      { sourceId: otherSourceId, sourceDocumentId: "republication" },
    ].map(({ sourceId: rowSourceId, sourceDocumentId }) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId: rowSourceId,
      sourceDocumentId,
      country: input.country,
      court: input.court,
      language: input.language,
      caseNumber,
      docketFamilyKey: docketFamilyKeyOf(caseNumber, input.country),
      decisionDate: input.decisionDate,
      decisionType: input.decisionType,
      ecli,
    }));
    await db.insert(caseLawDecisions).values(values);

    const identity = await db.transaction(async (tx) => {
      const observedDecision = observeDecision({ input, sourceId });
      return await resolveDecisionIdentityTx(asTestRaw<Transaction>(tx), {
        ...observedDecision,
        sourceId,
        statedEcliIdentity: STATED_ECLI_IDENTITY.DECISION,
        proposedDecisionId: createSafeId<"caseLawDecision">(),
      });
    });

    expect(identity.existing).toBeUndefined();
    expect(identity.ecliIdentity).toEqual({
      type: "ambiguous",
      sourceDocumentId: input.sourceDocumentId,
    });
    expect(identity.republished).toBeUndefined();
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

  test("real ingestion links a republication and preserves publisher provenance on replay", async () => {
    const [adapterA, adapterB] = listAdapterKeys();
    if (adapterA === undefined || adapterB === undefined) {
      throw new Error("Two registered adapter fixtures are required");
    }
    const sourceA = registeredSourceIds.get(adapterA);
    const sourceB = registeredSourceIds.get(adapterB);
    if (sourceA === undefined || sourceB === undefined) {
      throw new Error("Registered adapter source fixture is absent");
    }
    const fakeS3 = startFakeS3();
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));
    const caseNumber = "II OSK 98765/26";
    const sourceAUrl = "https://publisher-a.example.invalid/rulings/original";
    const sourceBUrl =
      "https://publisher-b.example.invalid/rulings/republication";
    const first = plainTextIngestionResult({
      ...observed,
      caseNumber,
      sourceDocumentId: "publisher-a-document",
      sourceRaw: JSON.stringify({ publisher: "A", record: "original" }),
      sourceUrl: sourceAUrl,
      rawHash: "publisher-a-raw-hash",
      fulltext: "Canonical text from publisher A.",
    });
    const republished = plainTextIngestionResult({
      ...first,
      sourceDocumentId: "publisher-b-document",
      sourceRaw: JSON.stringify({ publisher: "B", record: "republication" }),
      sourceUrl: sourceBUrl,
      rawHash: "publisher-b-raw-hash",
      fulltext: "Different text from publisher B.",
    });
    const decisions = async () =>
      await db
        .select({
          id: caseLawDecisions.id,
          court: caseLawDecisions.court,
          decisionDate: caseLawDecisions.decisionDate,
          decisionType: caseLawDecisions.decisionType,
          fulltext: caseLawDecisions.fulltext,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.caseNumber, caseNumber));
    const ingest = async (
      input: typeof first,
      sourceId: typeof sourceA,
      observationOrder: bigint,
    ) =>
      await processDecision({
        input,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-10-20T00:00:00Z"),
        observationOrder,
      });

    await ingest(first, sourceA, 1n);
    const afterFirst = await decisions();
    expect(afterFirst).toHaveLength(1);
    const canonical = afterFirst.at(0);
    if (canonical === undefined) {
      throw new Error("Canonical decision fixture is absent");
    }
    expect(canonical).toMatchObject({
      court: first.court,
      decisionDate: first.decisionDate,
      decisionType: first.decisionType,
      fulltext: first.fulltext,
    });

    await ingest(republished, sourceB, 1n);
    expect(await decisions()).toEqual([canonical]);
    const identitiesAfterLink = await db
      .select({
        sourceId: caseLawDecisionSourceIdentities.sourceId,
        sourceDocumentId: caseLawDecisionSourceIdentities.sourceDocumentId,
        sourceRawS3Key: caseLawDecisionSourceIdentities.sourceRawS3Key,
        sourceUrl: caseLawDecisionSourceIdentities.sourceUrl,
      })
      .from(caseLawDecisionSourceIdentities)
      .where(eq(caseLawDecisionSourceIdentities.decisionId, canonical.id))
      .orderBy(caseLawDecisionSourceIdentities.sourceDocumentId);
    expect(identitiesAfterLink).toHaveLength(2);
    expect(identitiesAfterLink).toEqual([
      {
        sourceId: sourceA,
        sourceDocumentId: first.sourceDocumentId,
        sourceRawS3Key: expect.any(String),
        sourceUrl: sourceAUrl,
      },
      {
        sourceId: sourceB,
        sourceDocumentId: republished.sourceDocumentId,
        sourceRawS3Key: expect.any(String),
        sourceUrl: sourceBUrl,
      },
    ]);

    await ingest(republished, sourceB, 2n);
    expect(await decisions()).toEqual([canonical]);
    expect(
      await db
        .select({
          sourceId: caseLawDecisionSourceIdentities.sourceId,
          sourceDocumentId: caseLawDecisionSourceIdentities.sourceDocumentId,
          sourceRawS3Key: caseLawDecisionSourceIdentities.sourceRawS3Key,
          sourceUrl: caseLawDecisionSourceIdentities.sourceUrl,
        })
        .from(caseLawDecisionSourceIdentities)
        .where(eq(caseLawDecisionSourceIdentities.decisionId, canonical.id))
        .orderBy(caseLawDecisionSourceIdentities.sourceDocumentId),
    ).toEqual(identitiesAfterLink);
    fakeS3.stop();
  });

  test("a late older observation never replaces newer raw provenance, even at the same timestamp", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const sourceId = sourceAt(1);
    await db.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      sourceDocumentId: "ordered-document",
      country: "POL",
      court: observed.court,
      language: observed.language,
      caseNumber: "RAW 3/26",
      docketFamilyKey: docketFamilyKeyOf("RAW 3/26", "POL"),
    });
    await db.insert(caseLawDecisionSourceIdentities).values({
      sourceId,
      sourceDocumentId: "ordered-document",
      decisionId,
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));
    // Both observations share one timestamp: only the observation order
    // tells them apart, and the older one finishes last.
    const record = async (key: string, observationOrder: bigint) =>
      await recordSourceIdentityRaw({
        scopedDb,
        sourceId,
        decisionId,
        sourceDocumentId: "ordered-document",
        rawArtifact: {
          sourceRawS3Key: key,
          sourceRawContentType: "application/json",
        },
        sourceUrl: `https://example.invalid/${key}`,
        observedAt: new Date("2026-10-20T12:00:00Z"),
        observationOrder,
      });

    await record("raw/newer", 2n);
    await record("raw/older", 1n);

    expect(
      await db
        .select({
          sourceRawS3Key: caseLawDecisionSourceIdentities.sourceRawS3Key,
          sourceUrl: caseLawDecisionSourceIdentities.sourceUrl,
        })
        .from(caseLawDecisionSourceIdentities)
        .where(eq(caseLawDecisionSourceIdentities.decisionId, decisionId)),
    ).toEqual([
      {
        sourceRawS3Key: "raw/newer",
        sourceUrl: "https://example.invalid/raw/newer",
      },
    ]);
  });

  test("raw provenance is never written to a redacted decision", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const sourceId = sourceAt(1);
    await db.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      sourceDocumentId: "redacted-document",
      country: "POL",
      court: observed.court,
      language: observed.language,
      caseNumber: "RAW 2/26",
      docketFamilyKey: docketFamilyKeyOf("RAW 2/26", "POL"),
      redactedAt: new Date("2026-10-19T00:00:00Z"),
    });
    await db.insert(caseLawDecisionSourceIdentities).values({
      sourceId,
      sourceDocumentId: "redacted-document",
      decisionId,
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));

    await recordSourceIdentityRaw({
      scopedDb,
      sourceId,
      decisionId,
      sourceDocumentId: "redacted-document",
      rawArtifact: {
        sourceRawS3Key: "raw/redacted/late",
        sourceRawContentType: "application/json",
      },
      sourceUrl: "https://example.invalid/redacted",
      observedAt: new Date("2026-10-20T00:00:00Z"),
      observationOrder: 1n,
    });

    expect(
      await db
        .select({
          sourceRawS3Key: caseLawDecisionSourceIdentities.sourceRawS3Key,
          sourceUrl: caseLawDecisionSourceIdentities.sourceUrl,
        })
        .from(caseLawDecisionSourceIdentities)
        .where(eq(caseLawDecisionSourceIdentities.decisionId, decisionId)),
    ).toEqual([{ sourceRawS3Key: null, sourceUrl: null }]);
  });

  // Runs last: its exact matches would make earlier link expectations ambiguous.
  test("a bounded complete candidate set remains ambiguous", async () => {
    const decisionIds = Array.from({ length: 18 }, () =>
      createSafeId<"caseLawDecision">(),
    );
    const docketFamilyKey = docketFamilyKeyOf(
      observed.caseNumber,
      observed.country,
    );
    await db.insert(caseLawDecisions).values(
      decisionIds.map((id, index) => ({
        id,
        sourceId: sourceAt(index + 1),
        sourceDocumentId: `ambiguous-${String(index)}`,
        country: observed.country,
        court: observed.court,
        language: observed.language,
        caseNumber: observed.caseNumber,
        docketFamilyKey,
        decisionDate:
          index === 0 || index === decisionIds.length - 1
            ? observed.decisionDate
            : "2024-06-04",
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
    ).toEqual({ type: REPUBLISHED_RULING_OUTCOME.SEPARATE_AMBIGUOUS });
  });
});
