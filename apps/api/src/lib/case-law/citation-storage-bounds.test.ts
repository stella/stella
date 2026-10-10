import { expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { assertProperty } from "@stll/property-testing";

import {
  caseLawCitationReviews,
  caseLawCitations,
  caseLawDecisions,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import {
  bareCitationKey,
  citationKeyOf,
  decisionCitationKeyOf,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { citationRowOf } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import { createSafeId } from "@/api/lib/branded-types";

import {
  CITATION_STORAGE_WIDTHS,
  CitationStorageFieldError,
  assertCitationStorageField,
  fitsCitationStorageField,
} from "./citation-storage-bounds";

const text = (maximum: number) =>
  fc
    .array(fc.constantFrom("a", "Č", "𐐀", "😀", " ", "9"), {
      maxLength: maximum,
    })
    .map((parts) => parts.join(""));

test("all persisted citation key columns share the schema-derived width", () => {
  expect(caseLawDecisions.citationKey.length).toBe(CITATION_STORAGE_WIDTHS.key);
  expect(caseLawCitationReviews.citationKey.length).toBe(
    CITATION_STORAGE_WIDTHS.key,
  );
  expect(caseLawCitations.citationText.length).toBe(
    CITATION_STORAGE_WIDTHS.text,
  );
  expect(caseLawCitations.citedCourtHint.length).toBe(
    CITATION_STORAGE_WIDTHS.courtHint,
  );
  expect(caseLawCitations.normalizedIdentifierValue.length).toBe(
    CITATION_STORAGE_WIDTHS.normalizedIdentifier,
  );
});

test("citation keys preserve exact fitting identities and null oversized identities", () => {
  assertProperty(
    "citation keys preserve exact fitting identities and null oversized identities",
    fc.property(text(700), (value) => {
      const bare = bareCitationKey(value);
      const expected =
        bare.length > 0 &&
        Array.from(bare).length <= CITATION_STORAGE_WIDTHS.key
          ? bare
          : null;
      expect(citationKeyOf(value)).toBe(expected);
      expect(
        decisionCitationKeyOf({
          caseNumber: value,
          caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        }),
      ).toBe(expected);
    }),
  );
});

test("key generation nulls oversized identities at exact character boundaries", () => {
  for (const character of ["a", "𐐀"]) {
    const exact = character.repeat(CITATION_STORAGE_WIDTHS.key);
    expect(citationKeyOf(exact)).toBe(bareCitationKey(exact));
    expect(citationKeyOf(exact + character)).toBeNull();
    expect(
      decisionCitationKeyOf({
        caseNumber: exact + character,
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      }),
    ).toBeNull();
  }
});

test("each varchar boundary counts Postgres characters without truncation", () => {
  // Typed field enumeration keeps the checked field and its schema width paired.
  const fields = [
    "key",
    "text",
    "courtHint",
    "normalizedIdentifier",
    "caseNumber",
    "court",
  ] as const;
  expect(Object.keys(CITATION_STORAGE_WIDTHS).toSorted()).toEqual(
    [...fields].toSorted(),
  );
  for (const field of fields) {
    for (const character of ["a", "𐐀"]) {
      const exact = character.repeat(CITATION_STORAGE_WIDTHS[field]);
      const over = `${exact}${character}`;
      expect(assertCitationStorageField(field, exact).unwrap()).toBe(exact);
      expect(assertCitationStorageField(field, null).unwrap()).toBeNull();
      expect(fitsCitationStorageField(field, over)).toBe(false);
      const refused = assertCitationStorageField(field, over);
      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(refused.error).toBeInstanceOf(CitationStorageFieldError);
        expect(refused.error.field).toBe(field);
        expect(refused.error.maximum).toBe(CITATION_STORAGE_WIDTHS[field]);
      }
    }
  }
});

test("citation row projection either fits every column or refuses before SQL", () => {
  const decisionId = createSafeId<"caseLawDecision">();
  assertProperty(
    "citation row projection either fits every column or refuses before SQL",
    fc.property(
      fc.record({
        printed: text(600),
        key: fc.option(text(160), { nil: null }),
        hint: fc.option(text(160), { nil: null }),
        identifier: text(300),
      }),
      ({ printed, key, hint, identifier }) => {
        const row = citationRowOf(decisionId, {
          verdict: null,
          reference: {
            index: 0,
            printed,
            citationKey: key,
            identifiers: [
              {
                type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                normalizedValue: identifier,
              },
            ],
            kind: CITATION_KIND.PRECEDENT,
            hints: {
              court: hint,
              decisionType: null,
              sheetNumber: null,
              decisionDate: null,
            },
            sectionIndex: null,
            polarityMentions: null,
          },
        });
        const fits =
          Array.from(printed).length <= CITATION_STORAGE_WIDTHS.text &&
          (key === null ||
            Array.from(key).length <= CITATION_STORAGE_WIDTHS.key) &&
          (hint === null ||
            Array.from(hint).length <= CITATION_STORAGE_WIDTHS.courtHint) &&
          Array.from(identifier).length <=
            CITATION_STORAGE_WIDTHS.normalizedIdentifier;
        expect(row.isOk()).toBe(fits);
        if (row.isErr()) {
          expect(row.error).toBeInstanceOf(CitationStorageFieldError);
          return;
        }
        expect(row.value.citationText).toBe(printed);
        expect(row.value.citationKey).toBe(key);
        expect(row.value.citedCourtHint).toBe(hint);
        expect(row.value.normalizedIdentifierValue).toBe(identifier);
      },
    ),
  );
});

const project = ({
  printed = "citation",
  key = "key",
  hint = "court",
  identifier = "reference",
}: {
  printed?: string;
  key?: string;
  hint?: string;
  identifier?: string;
}) =>
  citationRowOf(createSafeId<"caseLawDecision">(), {
    verdict: null,
    reference: {
      index: 0,
      printed,
      citationKey: key,
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          normalizedValue: identifier,
        },
      ],
      kind: CITATION_KIND.PRECEDENT,
      hints: {
        court: hint,
        decisionType: null,
        sheetNumber: null,
        decisionDate: null,
      },
      sectionIndex: null,
      polarityMentions: null,
    },
  });

test("each citation row field is checked independently at its schema boundary", () => {
  for (const { field, input, column } of [
    { field: "text", input: "printed", column: "citationText" },
    { field: "key", input: "key", column: "citationKey" },
    { field: "courtHint", input: "hint", column: "citedCourtHint" },
    {
      field: "normalizedIdentifier",
      input: "identifier",
      column: "normalizedIdentifierValue",
    },
  ] as const) {
    for (const character of ["a", "𐐀"]) {
      const exact = character.repeat(CITATION_STORAGE_WIDTHS[field]);
      expect(project({ [input]: exact }).unwrap()[column]).toBe(exact);
      const refused = project({ [input]: exact + character });
      expect(refused.isErr()).toBe(true);
      if (refused.isOk()) {
        throw new Error("Expected citation field refusal");
      }
      expect(refused.error).toBeInstanceOf(CitationStorageFieldError);
      expect(refused.error).toMatchObject({ field });
    }
  }
});
