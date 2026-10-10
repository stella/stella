import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { CASE_LAW_CORPUS_MIRROR_STATUS } from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  classifyObservation,
  resolveExistingDecisionPolicy,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-existing";
import type { ExistingDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { parsePrimaryReferenceType } from "@/api/lib/legal-search/decision-primary-reference";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { DOCUMENT_DELIVERY } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";

// A source fingerprint that leaves the record out hashes a listing-only
// observation and the complete one that follows it the same. The complete
// one must still be written, or the row stays listing-only forever.

/** The same publisher hash for both observations, as such a fingerprint states. */
const RAW_HASH = "fingerprint-without-detail";

type ObservationOverrides = { isListingOnly?: true; ecli?: string };

const observation = (overrides: ObservationOverrides): IngestionResult =>
  sanitizeResult(
    plainTextIngestionResult({
      caseNumber: "5C/12/2024",
      sourceDocumentId: "guid-1",
      court: "Okresný súd Bratislava I",
      country: "SVK",
      language: "sk",
      decisionDate: "2024-05-14",
      decisionType: "Rozsudok",
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      metadata: { court: "Okresný súd Bratislava I" },
      rawHash: RAW_HASH,
      documentAst: EMPTY_AST,
      documentDelivery: DOCUMENT_DELIVERY.DEFERRED,
      ...overrides,
    }),
  );

const stored = (result: IngestionResult): ExistingDecision => ({
  id: createSafeId<"caseLawDecision">(),
  caseNumber: result.caseNumber,
  caseNumberType: parsePrimaryReferenceType(result.caseNumberType),
  citationKey: null,
  country: result.country,
  decisionDate: result.decisionDate ?? null,
  sourceDocumentId: result.sourceDocumentId ?? null,
  ecli: result.ecli ?? null,
  metadata: result.metadata,
  sourceHash: result.rawHash,
  sourceObservedAt: new Date("2026-10-01T00:00:00Z"),
  sourceObservationHash: result.rawHash,
  redactedAt: null,
  corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
  contentHash: null,
  textS3Key: null,
  normalizedS3Key: null,
  astS3Key: null,
  sourceRawS3Key: "stored/raw",
  sourceRawContentType: result.sourceRawContentType ?? null,
  sourceUrl: result.sourceUrl ?? null,
  hasStoredDocument: false,
});

/** The skip path is the only one that reaches the database; it must not. */
const unreachableDb: ScopedDb = async () =>
  await Promise.resolve(panic("the observation was skipped"));

describe("an observation that completes a listing-only row", () => {
  test("is written although the publisher hash is unchanged", async () => {
    const listingOnly = observation({ isListingOnly: true });
    const complete = observation({ ecli: "ECLI:SK:OSBA1:2024:1" });
    expect(complete.rawHash).toBe(listingOnly.rawHash);
    const existing = stored(listingOnly);

    const shape = classifyObservation({ result: complete, existing });

    expect(shape.upgradesStoredDetail).toBe(true);
    expect(
      await resolveExistingDecisionPolicy({
        scopedDb: unreachableDb,
        existing,
        result: complete,
        shape,
        observedAt: new Date("2026-10-02T00:00:00Z"),
        observationOrder: 2n,
        refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      }),
    ).toBeNull();
  });

  test("a listing-only observation of a listing-only row upgrades nothing", () => {
    const listingOnly = observation({ isListingOnly: true });

    expect(
      classifyObservation({
        result: listingOnly,
        existing: stored(listingOnly),
      }).upgradesStoredDetail,
    ).toBe(false);
  });

  test("an observation of a row never stored upgrades nothing", () => {
    expect(
      classifyObservation({ result: observation({}), existing: undefined })
        .upgradesStoredDetail,
    ).toBe(false);
  });
});
