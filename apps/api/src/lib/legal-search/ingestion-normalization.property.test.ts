import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { CITATION_STORAGE_WIDTHS } from "@/api/handlers/case-law/citation-storage-bounds";
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

for (const { field, errorField } of [
  {
    field: "caseNumber",
    errorField: UNPERSISTABLE_DECISION_FIELDS.CASE_NUMBER_LENGTH,
  },
  { field: "court", errorField: UNPERSISTABLE_DECISION_FIELDS.COURT_LENGTH },
] as const) {
  const width = CITATION_STORAGE_WIDTHS[field];
  test(`${field} storage is exact or a typed refusal for generated Unicode values`, () => {
    assertProperty(
      `${field} storage is exact or a typed refusal for generated Unicode values`,
      fc.property(
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
          if (characters.length <= width) {
            expect(result.unwrap()[field]).toBe(value);
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
        },
      ),
    );
  });
}
