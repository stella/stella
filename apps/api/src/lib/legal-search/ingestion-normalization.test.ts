import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CITATION_STORAGE_WIDTHS } from "@/api/lib/case-law/citation-storage-bounds";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
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
            expect(result.error).toMatchObject({ field: errorField });
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
});
