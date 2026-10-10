import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CITATION_STORAGE_WIDTHS } from "@/api/lib/case-law/citation-storage-bounds";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import {
  CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES,
  fitsSearchCandidateRow,
} from "@/api/lib/case-law/search-candidate-row-bound-sql";
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

const fields = [
  {
    field: "caseNumber",
    errorField: UNPERSISTABLE_DECISION_FIELDS.CASE_NUMBER_LENGTH,
  },
  { field: "court", errorField: UNPERSISTABLE_DECISION_FIELDS.COURT_LENGTH },
] as const;

describe("decision storage normalization", () => {
  for (const { field, errorField } of fields) {
    test(`${field} retains exact Unicode text through its storage boundary`, () => {
      const width = CITATION_STORAGE_WIDTHS[field];
      for (const token of ["x", "é", "😀", "\u0301"]) {
        for (const length of [width - 1, width, width + 1]) {
          const value = token.repeat(length);
          const result = Result.try({
            try: () => sanitizeResult({ ...decision, [field]: value }),
            catch: (error: unknown) => error,
          });
          if (length <= width) {
            expect(value).toBe(result.unwrap()[field]);
          } else {
            expect(result.isErr()).toBe(true);
            if (result.isOk()) {
              throw new Error("Expected storage refusal");
            }
            expect(result.error).toBeInstanceOf(
              UnpersistableDecisionFieldError,
            );
            expect(result.error).toMatchObject({
              field: errorField,
            });
          }
        }
      }
    });

    test(`${field} checks the sanitized stored value without trimming an identity`, () => {
      const value = "x".repeat(CITATION_STORAGE_WIDTHS[field]);
      const normalized = sanitizeResult({
        ...decision,
        [field]: `\0${value}\0`,
      });
      expect(value).toBe(normalized[field]);
      expect(normalized.sourceDocumentId).toBe(decision.sourceDocumentId);
      expect(value).toBe(
        sanitizeResult({ ...decision, [field]: normalized[field] })[field],
      );
    });
  }

  test("a 512 character emoji court is normalized intact and fails the aggregate byte check", () => {
    const court = "😀".repeat(512);
    expect(Array.from(court).length).toBe(CITATION_STORAGE_WIDTHS.court);
    const normalized = sanitizeResult({ ...decision, court });
    expect(court).toBe(normalized.court);
    expect(fitsDecisionSearchCandidateRow(normalized)).toBe(false);
  });

  test("the combined UTF8 budget uses the stored docket and normalized decision type", () => {
    const court = "😀".repeat(480);
    const sourceId = "019a08bf-0600-7000-8000-000000000001";
    const languageGroupKey = decisionLanguageGroupKey({
      caseNumber: decision.caseNumber,
      country: decision.country,
      ecli: decision.ecli,
      sourceDocumentId: decision.sourceDocumentId,
      sourceId,
    });
    const typeBytes =
      CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES -
      Buffer.byteLength(court) -
      Buffer.byteLength(languageGroupKey);
    expect(typeBytes).toBeGreaterThan(0);
    const input = {
      ...decision,
      court: `\0${court}`,
      decisionType: ` JMÉNEM REPUBLIKY ${"X".repeat(typeBytes)}\0 `,
    };
    const normalized = sanitizeResult(input);
    expect(normalized.court === court).toBe(true);
    expect(normalized.decisionType === "x".repeat(typeBytes)).toBe(true);
    expect(
      sanitizeResult({
        ...decision,
        court: normalized.court,
        decisionType: normalized.decisionType,
      }),
    ).toEqual(normalized);
    expect(fitsDecisionSearchCandidateRow(normalized)).toBe(true);
    const overBudget = sanitizeResult({
      ...input,
      decisionType: ` JMÉNEM REPUBLIKY ${"X".repeat(typeBytes + 1)}\0 `,
    });
    expect(fitsDecisionSearchCandidateRow(overBudget)).toBe(false);
  });

  test("adapter byte reservation agrees with real generated keys for every identity policy", () => {
    const sourceId = "019a08bf-0600-7000-8000-000000000001";
    for (const identity of [
      { country: "POL", ecli: undefined, caseNumber: "é😀".repeat(100) },
      { country: "EU", ecli: "ECLI:EU:C:2026:1", caseNumber: "C-1/26" },
      { country: "USA", ecli: "ignored", sourceDocumentId: "é😀".repeat(100) },
    ]) {
      const input = { ...decision, ...identity, court: "" };
      const languageGroupKey = decisionLanguageGroupKey({
        caseNumber: input.caseNumber,
        country: input.country,
        ecli: input.ecli,
        sourceDocumentId: input.sourceDocumentId,
        sourceId,
      });
      const remaining =
        CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES -
        Buffer.byteLength(languageGroupKey);
      for (const delta of [-1, 0, 1]) {
        const candidate = { ...input, court: "x".repeat(remaining + delta) };
        expect(fitsDecisionSearchCandidateRow(candidate)).toBe(delta <= 0);
        expect(fitsDecisionSearchCandidateRow(candidate)).toBe(
          fitsSearchCandidateRow({
            court: candidate.court,
            decisionType: candidate.decisionType,
            languageGroupKey,
          }),
        );
      }
    }
  });
});
