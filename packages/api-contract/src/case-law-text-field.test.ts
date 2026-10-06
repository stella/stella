import { expect, test } from "bun:test";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  DECISION_TEXT_FIELD_KEYS,
  DECISION_ABSENCE_FIELD_KEYS,
  inspectDecisionTextAbsence,
  parseDecisionTextAbsence,
  TEXT_ABSENCE_REASONS,
} from "./case-law-text-field";

test("unstamped nullable publisher text remains a legacy observation", () => {
  expect(inspectDecisionTextAbsence(null)).toEqual({ type: "legacy" });
  expect(inspectDecisionTextAbsence({})).toEqual({ type: "legacy" });
  for (const field of DECISION_TEXT_FIELD_KEYS) {
    expect(inspectDecisionTextAbsence({ [field]: null })).toEqual({
      type: "legacy",
    });
  }
});

test("every current null without its own marker is a publication defect", () => {
  for (const reason of TEXT_ABSENCE_REASONS) {
    const entries = DECISION_TEXT_FIELD_KEYS.map((field) => ({
      field,
      reason,
    }));
    for (const missing of DECISION_TEXT_FIELD_KEYS) {
      const stored = {
        [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
          DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
        [DECISION_TEXT_ABSENCE_METADATA_KEY]: entries.filter(
          ({ field }) => field !== missing,
        ),
      };
      expect(inspectDecisionTextAbsence(stored)).toEqual({
        type: "current",
        missingFields: [missing],
      });
      expect(
        inspectDecisionTextAbsence({
          ...stored,
          [missing]: "Publisher text\n  stays intact",
        }),
      ).toEqual({ type: "current", missingFields: [] });
      expect(
        inspectDecisionTextAbsence({
          ...stored,
          [missing]: null,
        }),
      ).toEqual({ type: "current", missingFields: [missing] });
    }
    expect(
      inspectDecisionTextAbsence({
        [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
          DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
        [DECISION_TEXT_ABSENCE_METADATA_KEY]: entries,
      }),
    ).toEqual({ type: "current", missingFields: [] });
  }
});

test("a current write with no markers identifies every nullable field", () => {
  expect(
    inspectDecisionTextAbsence({
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
    }),
  ).toEqual({ type: "current", missingFields: DECISION_TEXT_FIELD_KEYS });
});

test("malformed sidecars and unknown schema versions cannot appear complete", () => {
  for (const value of [null, 0, 1, 3, "2", {}, []]) {
    expect(
      inspectDecisionTextAbsence({
        [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]: value,
      }),
    ).toEqual({ type: "invalid", reason: "schema_version" });
  }
  for (const sidecar of [
    null,
    {},
    [{ field: "unknown", reason: "unknown_reason" }],
    [{ field: "abstract", reason: "unknown" }],
    [{ field: "abstract", reason: 2 }],
    [{ field: "abstract", reason: "not_published", extra: true }],
    [
      { field: "abstract", reason: "not_published" },
      { field: "abstract", reason: "parse_failed" },
    ],
  ]) {
    expect(parseDecisionTextAbsence(sidecar)).toEqual({ type: "invalid" });
    expect(
      inspectDecisionTextAbsence({
        [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
          DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
        [DECISION_TEXT_ABSENCE_METADATA_KEY]: sidecar,
      }),
    ).toEqual({ type: "invalid", reason: "sidecar" });
  }
});

test("the shared sidecar accepts every publisher field and existing absence reason", () => {
  for (const field of DECISION_ABSENCE_FIELD_KEYS) {
    for (const reason of TEXT_ABSENCE_REASONS) {
      const entries = [{ field, reason }];
      expect(parseDecisionTextAbsence(entries)).toEqual({
        type: "valid",
        entries,
      });
    }
  }
});
