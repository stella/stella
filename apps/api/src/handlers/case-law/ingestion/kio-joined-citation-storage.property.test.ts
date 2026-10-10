import { expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { assertProperty } from "@stll/property-testing";

import { deriveDecisionReferences } from "@/api/handlers/case-law/citations/decision-references";
import {
  bareCitationKey,
  extractCitations,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { citationRowOf } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import { createSafeId } from "@/api/lib/branded-types";
import { CITATION_STORAGE_WIDTHS } from "@/api/lib/case-law/citation-storage-bounds";

const joinedDockets = fc
  .uniqueArray(
    fc.tuple(
      fc.integer({ min: 1000, max: 999_999 }),
      fc.integer({ min: 0, max: 99 }),
      fc.constantFrom("KIO", "KIO/UZP"),
    ),
    {
      minLength: 12,
      maxLength: 70,
      selector: ([number, year]) => `${number}/${year}`,
    },
  )
  .map((items) =>
    items.map(
      ([number, year, prefix]) =>
        `${prefix} ${number}/${String(year).padStart(2, "0")}`,
    ),
  );

test("generated joined dockets retain every exact spelling and fit their citation rows", () => {
  const citingDecisionId = createSafeId<"caseLawDecision">();
  assertProperty(
    "generated joined dockets retain every exact spelling and fit their citation rows",
    fc.property(
      joinedDockets,
      fc.constantFrom(", ", ",\n", ",  \n "),
      (dockets, separator) => {
        const text = `por. wyroki ${dockets.join(separator)} oraz KIO 7/22.`;
        const sections = [{ index: 0, text }];
        const citations = extractCitations(sections);
        expect(citations.map(({ citationText }) => citationText)).toEqual([
          ...dockets,
          "KIO 7/22",
        ]);
        for (const citation of citations) {
          expect(
            Array.from(bareCitationKey(citation.citationText)).length,
          ).toBeLessThanOrEqual(CITATION_STORAGE_WIDTHS.key);
          expect(Array.from(citation.citationText).length).toBeLessThanOrEqual(
            CITATION_STORAGE_WIDTHS.text,
          );
          expect(text).toContain(citation.citationText);
        }
        const { references } = deriveDecisionReferences({
          citingDecisionId,
          citations,
          proceduralKeys: new Set(),
          sections,
        });
        expect(references).toHaveLength(citations.length);
        for (const reference of references) {
          const row = citationRowOf(citingDecisionId, {
            reference,
            verdict: null,
          }).unwrap();
          expect(row.citationText).toBe(reference.printed);
          expect(row.citationKey).toBe(bareCitationKey(reference.printed));
          expect(row.normalizedIdentifierValue).toBe(
            normalizeDecisionIdentifierValue(
              DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
              reference.printed,
            ),
          );
        }
      },
    ),
  );
});

test("a fitting joined docket remains one exact citation", () => {
  const text = "KIO 1/25, KIO 2/25";
  const citations = extractCitations([{ index: 0, text }]);
  expect(citations).toHaveLength(1);
  expect(citations[0]?.citationText).toBe(text);
});

test("joined keys split only above their exact schema boundary", () => {
  for (const length of [
    CITATION_STORAGE_WIDTHS.key - 1,
    CITATION_STORAGE_WIDTHS.key,
    CITATION_STORAGE_WIDTHS.key + 1,
  ]) {
    const numbers = Array.from({ length: 12 }, (_, index) => String(index + 1));
    const base = numbers.map((number) => `KIO ${number}/25`).join(", ");
    let remaining = length - Array.from(bareCitationKey(base)).length;
    const dockets = numbers.map((number) => {
      const extra = Math.min(remaining, 6 - number.length);
      remaining -= extra;
      return `KIO ${number}${"2".repeat(extra)}/25`;
    });
    expect(remaining).toBe(0);
    const text = dockets.join(", ");
    expect(Array.from(bareCitationKey(text)).length).toBe(length);
    expect(
      extractCitations([{ index: 0, text }]).map(
        ({ citationText }) => citationText,
      ),
    ).toEqual(length <= CITATION_STORAGE_WIDTHS.key ? [text] : dockets);
  }
});
