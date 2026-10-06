import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_FIELD_KEYS,
  TEXT_ABSENCE_REASONS,
  TEXT_ABSENCE_REASON,
} from "@stll/api-contract/case-law-text-field";
import { propertyConfig } from "@stll/property-testing";

import {
  absentTextField,
  presentTextField,
  readDecisionTextMetadata,
  readStoredDecisionTextAbsence,
  storeDecisionTextFields,
} from "./decision-text";

const textField = fc.oneof(
  fc.constantFrom(...TEXT_ABSENCE_REASONS).map(absentTextField),
  fc.stringMatching(/^[a-zA-Z]{1,30}$/u).map(presentTextField),
);
const fields = fc.record({
  abstract: textField,
  headnote: textField,
  legalSentence: textField,
  summary: textField,
});
const unknownEntries = fc.uniqueArray(
  fc.record({
    field: fc.string({ maxLength: 20 }).map((value) => `future:${value}`),
    reason: fc.constantFrom(...TEXT_ABSENCE_REASONS),
  }),
  { selector: ({ field }) => field, maxLength: 8 },
);

test("versioned writes and future sidecars read the same text states", () => {
  fc.assert(
    fc.property(
      fields,
      unknownEntries,
      fc.jsonValue(),
      (textFields, extra, version) => {
        const stored = storeDecisionTextFields({
          metadata: { publisher: "fixture" },
          textFields,
        });
        const expected: Record<string, unknown> = {
          publisher: "fixture",
          _stellaDecisionTextAbsenceVersion: 2,
        };

        const explicit = [];
        for (const field of DECISION_TEXT_FIELD_KEYS) {
          const value = textFields[field];
          if (value.type === "present") {
            expected[field] = value.text;
            continue;
          }
          explicit.push({ field, reason: value.reason });
        }
        if (explicit.length > 0) {
          expected[DECISION_TEXT_ABSENCE_METADATA_KEY] = explicit;
        }
        expect(stored).toEqual(expected);
        expect(readDecisionTextMetadata(stored).textFields).toEqual(textFields);
        const future = {
          ...stored,
          _stellaDecisionTextAbsenceVersion: version,
          [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
            ...explicit,
            { field: "ecli", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
            { field: "sourceUrl", reason: TEXT_ABSENCE_REASON.PARSE_FAILED },
            ...extra,
          ],
        };
        expect(readDecisionTextMetadata(future).textFields).toEqual(textFields);
      },
    ),
    propertyConfig({ numRuns: 200 }),
  );
});

test("v2 explicit absence and unknown publisher fields preserve published text", () => {
  const metadata = {
    abstract: "Published abstract",
    headnote: "Published headnote",
    _stellaDecisionTextAbsenceVersion: 2,
    [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
      { field: "legalSentence", reason: "not_published" },
      { field: "summary", reason: "not_published" },
      { field: "ecli", reason: "not_published" },
      { field: "sourceUrl", reason: "parse_failed" },
    ],
  };
  expect(readDecisionTextMetadata(metadata).textFields).toEqual({
    abstract: presentTextField("Published abstract"),
    headnote: presentTextField("Published headnote"),
    legalSentence: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    summary: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });
});

test("unknown fields remain subject to structural and reason validation", () => {
  for (const entry of [
    { field: "ecli", reason: "unknown" },
    { field: "sourceUrl", reason: "not_published", extra: true },
    { field: "ecli", reason: null },
    { field: 2, reason: "not_published" },
    { field: "ecli" },
  ]) {
    expect(
      readStoredDecisionTextAbsence({
        [DECISION_TEXT_ABSENCE_METADATA_KEY]: [entry],
      }),
    ).toEqual({ type: "invalid" });
  }
  expect(
    readStoredDecisionTextAbsence({
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        { field: "ecli", reason: "not_published" },
        { field: "ecli", reason: "parse_failed" },
      ],
    }),
  ).toEqual({ type: "invalid" });
});
