import { afterEach, expect, test } from "bun:test";

import {
  DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  inspectDecisionTextAbsence,
  TEXT_ABSENCE_REASON,
  TEXT_ABSENCE_REASONS,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";

import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { caseLawCanonicalPayload } from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import {
  readStoredDecisionTextAbsence,
  splitStoredDecisionTextMetadata,
  storeDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { toPlainTextMetadataObject } from "@/api/lib/case-law/plain-text";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("every registered source has a publication fixture", () => {
  expect(Object.keys(CASE_LAW_CONFORMANCE_FIXTURES).toSorted()).toEqual(
    listSourceRegistrations()
      .map(({ key }) => key)
      .toSorted(),
  );
});

for (const { key } of listSourceRegistrations()) {
  test(`${key}: every absent publisher text field has a persisted reason`, async () => {
    const decision = await CASE_LAW_CONFORMANCE_FIXTURES[key]().buildDecision();
    const stored = storeDecisionTextFields({
      metadata: decision.metadata,
      textFields: decision.textFields,
    });
    const absence = readStoredDecisionTextAbsence(stored);
    expect(inspectDecisionTextAbsence(stored)).toEqual({
      type: "current",
      missingFields: [],
    });
    expect(absence.type).toBe("valid");
    if (absence.type !== "valid") {
      throw new TypeError(`${key}: invalid publication markers`);
    }
    for (const field of DECISION_TEXT_FIELD_KEYS) {
      const value = decision.textFields[field];
      const marker = absence.entries.find((entry) => entry.field === field);
      switch (value.type) {
        case TEXT_FIELD_TYPE.ABSENT:
          expect(stored[field] ?? null).toBeNull();
          expect(marker).toEqual({ field, reason: value.reason });
          expect(TEXT_ABSENCE_REASONS).toContain(value.reason);
          break;
        case TEXT_FIELD_TYPE.PRESENT:
          expect(stored[field]).toBe(value.text);
          expect(marker).toBeUndefined();
          break;
        default:
          value satisfies never;
      }
    }
    expect(splitStoredDecisionTextMetadata(stored).textFields).toEqual(
      decision.textFields,
    );
    const normalized = sanitizeResult(decision);
    // Legacy rows stored only non-default reasons. Provenance changes must
    // neither alter the document payload nor require a source refresh.
    const legacyEntries = absence.entries.filter(
      ({ reason }) => reason !== TEXT_ABSENCE_REASON.NOT_PUBLISHED,
    );
    const legacyMetadata: Record<string, unknown> = Object.fromEntries(
      Object.entries(normalized.metadata).filter(
        ([metadataKey]) =>
          metadataKey !== DECISION_TEXT_ABSENCE_METADATA_KEY &&
          metadataKey !== DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
      ),
    );
    if (legacyEntries.length > 0) {
      legacyMetadata[DECISION_TEXT_ABSENCE_METADATA_KEY] = legacyEntries;
    }
    expect(inspectDecisionTextAbsence(legacyMetadata)).toEqual({
      type: "legacy",
    });
    expect(
      normalized.metadata[DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY],
    ).toBe(DECISION_TEXT_ABSENCE_SCHEMA_VERSION);
    expect(
      caseLawCanonicalPayload({
        ...normalized,
        metadata: toPlainTextMetadataObject(legacyMetadata).unwrap(),
      }),
    ).toEqual(caseLawCanonicalPayload(normalized));
    expect(
      shouldSkipRefresh({
        existingMetadata: legacyMetadata,
        existingSourceHash: normalized.rawHash,
        incomingMetadata: normalized.metadata,
        incomingRawHash: normalized.rawHash,
      }),
    ).toBe(true);
  });
}
