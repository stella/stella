import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { CITATION_STORAGE_WIDTHS } from "@/api/lib/case-law/citation-storage-bounds";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES } from "@/api/lib/case-law/search-candidate-row-bound-sql";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { decisionLanguageGroupKey } from "@/api/lib/legal-search/decision-language-identity";
import {
  fitsDecisionSearchCandidateRow,
  sanitizeResult,
} from "@/api/lib/legal-search/ingestion-normalization";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";

const decision = plainTextIngestionResult({
  caseNumber: "reference",
  court: "court",
  country: "XAA",
  language: "en",
  sourceDocumentId: "document-1",
  metadata: {},
  rawHash: "hash",
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  documentAst: {},
});

const normalizationProperty = (
  field: "caseNumber" | "court",
  errorField: (typeof UNPERSISTABLE_DECISION_FIELDS)[keyof typeof UNPERSISTABLE_DECISION_FIELDS],
) => {
  const width = CITATION_STORAGE_WIDTHS[field];
  return fc.property(
    fc.array(fc.constantFrom("x", "é", "😀", "\u0301"), {
      minLength: width - 4,
      maxLength: width + 4,
    }),
    (characters) => {
      const value = characters.join("");
      const result = Result.try({
        try: () => sanitizeResult({ ...decision, [field]: value }),
        catch: (error: unknown) => error,
      });
      const input = {
        ...decision,
        [field]: value,
      };
      const languageGroupKey = decisionLanguageGroupKey({
        caseNumber: input.caseNumber,
        country: input.country,
        ecli: input.ecli,
        sourceDocumentId: input.sourceDocumentId,
        sourceId: "019a08bf-0600-7000-8000-000000000001",
      });
      const fitsBytes =
        Buffer.byteLength(input.court) + Buffer.byteLength(languageGroupKey) <=
        CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES;
      // Normalization refuses only the field width; the aggregate byte budget
      // is the write planner's check, made on the normalized value.
      if (characters.length <= width) {
        const normalized = result.unwrap();
        expect(value).toBe(normalized[field]);
        expect(fitsDecisionSearchCandidateRow(normalized)).toBe(fitsBytes);
      } else {
        expect(result.isErr()).toBe(true);
        if (result.isOk()) {
          throw new Error("Expected storage refusal");
        }
        expect(result.error).toBeInstanceOf(UnpersistableDecisionFieldError);
        expect(result.error).toMatchObject({ field: errorField });
      }
    },
  );
};

test("caseNumber storage is exact or a typed refusal for generated Unicode values", () => {
  assertProperty(
    "caseNumber storage is exact or a typed refusal for generated Unicode values",
    normalizationProperty(
      "caseNumber",
      UNPERSISTABLE_DECISION_FIELDS.CASE_NUMBER_LENGTH,
    ),
  );
});

test("court storage is exact or a typed refusal for generated Unicode values", () => {
  assertProperty(
    "court storage is exact or a typed refusal for generated Unicode values",
    normalizationProperty("court", UNPERSISTABLE_DECISION_FIELDS.COURT_LENGTH),
  );
});

test("generated decision candidates normalize intact and are judged against the aggregate UTF8 budget", () => {
  const unicode = (maximum: number) =>
    fc
      .array(fc.constantFrom("x", "é", "😀", "\u0301"), {
        minLength: maximum - 4,
        maxLength: maximum,
      })
      .map((characters) => characters.join(""));
  assertProperty(
    "generated decision candidates normalize intact and are judged against the aggregate UTF8 budget",
    fc.property(
      unicode(CITATION_STORAGE_WIDTHS.court),
      unicode(256),
      unicode(128),
      (court, ecli, decisionType) => {
        const input = { ...decision, court, ecli, decisionType };
        const languageGroupKey = decisionLanguageGroupKey({
          caseNumber: input.caseNumber,
          country: input.country,
          ecli: input.ecli,
          sourceDocumentId: input.sourceDocumentId,
          sourceId: "019a08bf-0600-7000-8000-000000000001",
        });
        const bytes =
          Buffer.byteLength(court) +
          Buffer.byteLength(languageGroupKey) +
          Buffer.byteLength(decisionType);
        const normalized = sanitizeResult(input);
        expect(normalized.court === court).toBe(true);
        expect(fitsDecisionSearchCandidateRow(normalized)).toBe(
          bytes <= CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES,
        );
        expect(
          sanitizeResult({
            ...decision,
            court: normalized.court,
            ecli: normalized.ecli,
            decisionType: normalized.decisionType,
          }),
        ).toEqual(normalized);
      },
    ),
  );
});
