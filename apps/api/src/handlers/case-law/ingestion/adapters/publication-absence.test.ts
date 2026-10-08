import { afterEach, expect, test } from "bun:test";

import {
  DECISION_PUBLICATION_FIELD_KEYS,
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  DECISION_TEXT_FIELD_KEYS,
  SK_US_ECLI_AVAILABILITY_STATUSES,
  SK_COURTS_SOURCE_URL_STATUSES,
  TEXT_ABSENCE_REASON,
  TEXT_ABSENCE_REASONS,
  parseDecisionTextAbsence,
  type SkUsEcliAvailability,
} from "@stll/api-contract/case-law-text-field";

import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  absentDecisionTextFields,
  splitStoredDecisionTextMetadata,
  storeDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { isRecord } from "@/api/lib/type-guards";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { TYPED_ABSENCE_DEBT } from "@/api/tests/helpers/case-law-publication-absence-debt";

const isStoredEcliAvailability = (
  value: unknown,
): value is SkUsEcliAvailability =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  SK_US_ECLI_AVAILABILITY_STATUSES.some((status) => status === value["status"]);

/** The stored ECLI availability, compared as its contract shape. */
const storedEcliAvailability = (
  value: unknown,
): SkUsEcliAvailability | undefined =>
  isStoredEcliAvailability(value) ? value : undefined;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const reason of TEXT_ABSENCE_REASONS) {
  for (const ecliStatus of SK_US_ECLI_AVAILABILITY_STATUSES) {
    for (const sourceUrlStatus of SK_COURTS_SOURCE_URL_STATUSES) {
      test(`publication statuses agree with sidecars: ${reason}/${ecliStatus}/${sourceUrlStatus}`, () => {
        const metadata = {
          ecliAvailability: { status: ecliStatus },
          sourceUrlStatus,
          statedSourceUrl: "https://publisher.invalid/stated-url",
        };
        const stored = storeDecisionTextFields({
          metadata,
          textFields: absentDecisionTextFields(reason),
        });
        const expected = DECISION_TEXT_FIELD_KEYS.map((field) => ({
          field,
          reason,
        }));
        expect(stored).toEqual({
          ...metadata,
          [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
            DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
          [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
            ...expected,
            ...(ecliStatus === "not_published"
              ? [{ field: "ecli", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED }]
              : []),
            ...(sourceUrlStatus === "not-published-by-source"
              ? [
                  {
                    field: "sourceUrl",
                    reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
                  },
                ]
              : []),
            ...(sourceUrlStatus === "rejected-url"
              ? [
                  {
                    field: "sourceUrl",
                    reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
                  },
                ]
              : []),
          ],
        });
        const split = splitStoredDecisionTextMetadata(stored);
        expect(storeDecisionTextFields(split)).toEqual(stored);
      });
    }
  }
}

test("a rejected URL cannot acquire a defect marker without retaining the publisher value", () => {
  for (const statedSourceUrl of [undefined, null, 2]) {
    expect(() =>
      storeDecisionTextFields({
        metadata: { sourceUrlStatus: "rejected-url", statedSourceUrl },
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      }),
    ).toThrow("Rejected publisher URLs must retain their stated value");
  }
});

test("publication absence debt covers a closed cohort and can only shrink", () => {
  expect(Object.keys(TYPED_ABSENCE_DEBT).toSorted()).toEqual(
    listSourceRegistrations()
      .map(({ key }) => key)
      .toSorted(),
  );
  const entries = Object.values(TYPED_ABSENCE_DEBT).flat();
  expect(entries.length).toBeLessThanOrEqual(149);
  for (const entry of entries) {
    expect(entry.reason.trim().length).toBeGreaterThan(0);
    expect(DECISION_PUBLICATION_FIELD_KEYS).toContain(entry.field);
  }
});

for (const { key } of listSourceRegistrations()) {
  test(`${key}: absent optional publisher fields have a derived marker or declared debt`, async () => {
    const decision = await CASE_LAW_CONFORMANCE_FIXTURES[key]().buildDecision();
    const stored = storeDecisionTextFields({
      metadata: decision.metadata,
      textFields: decision.textFields,
    });
    const parsed = parseDecisionTextAbsence(
      stored[DECISION_TEXT_ABSENCE_METADATA_KEY],
    );
    if (parsed.type !== "valid") {
      throw new TypeError("Expected valid sidecar");
    }
    for (const field of DECISION_PUBLICATION_FIELD_KEYS) {
      const marker = parsed.entries.find((entry) => entry.field === field);
      const debt = TYPED_ABSENCE_DEBT[key].find(
        (entry) => entry.field === field,
      );
      if (decision[field] !== undefined) {
        expect(marker).toBeUndefined();
        continue;
      }
      if (marker !== undefined) {
        expect(debt?.condition).not.toBe("always");
        continue;
      }
      if (
        field === "sourceUrl" &&
        decision.metadata["sourceUrlStatus"] === "detail-unavailable"
      ) {
        expect(marker).toBeUndefined();
        continue;
      }
      expect(debt).toBeDefined();
      if (debt?.condition === "not_stated") {
        expect(
          storedEcliAvailability(decision.metadata["ecliAvailability"]),
        ).toEqual({ status: "not_stated" });
      }
    }
  });
}

test("empty rejected publisher URLs retain their stated value and defect marker", () => {
  for (const statedSourceUrl of ["", "   "]) {
    const stored = storeDecisionTextFields({
      metadata: { statedSourceUrl, sourceUrlStatus: "rejected-url" },
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    });
    const sidecar = parseDecisionTextAbsence(
      stored[DECISION_TEXT_ABSENCE_METADATA_KEY],
    );
    expect(stored["statedSourceUrl"]).toBe(statedSourceUrl);
    if (sidecar.type !== "valid") {
      throw new TypeError("Expected valid sidecar");
    }
    expect(sidecar.entries.find(({ field }) => field === "sourceUrl")).toEqual({
      field: "sourceUrl",
      reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
    });
  }
});
