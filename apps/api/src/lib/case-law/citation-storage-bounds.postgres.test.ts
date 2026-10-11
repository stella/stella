import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import fc from "fast-check";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { assertProperty } from "@stll/property-testing";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { citationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { citationRowOf } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CITATION_STORAGE_WIDTHS,
  CitationStorageFieldError,
} from "@/api/lib/case-law/citation-storage-bounds";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("citation storage bounds", () => {
    test("requires an explicitly enabled Postgres database", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("citation storage bounds", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const sourceId = createSafeId<"caseLawSource">();
    cleanUp(async () => {
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });

    test("generated citation fields either write exactly or refuse before Postgres", async () => {
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `width-${sourceId}`,
        name: "width fixture",
      });
      const decisionId = createSafeId<"caseLawDecision">();
      await db.insert(caseLawDecisions).values({
        id: decisionId,
        sourceId,
        caseNumber: "width fixture",
        court: "fixture court",
        country: "CZE",
        language: "cs",
      });
      const field = (width: number) =>
        fc
          .array(fc.constantFrom("a", "Č", "𐐀"), {
            minLength: width - 2,
            maxLength: width + 2,
          })
          .map((characters) => characters.join(""));
      await assertProperty(
        "generated citation fields either write exactly or refuse before Postgres",
        fc.asyncProperty(
          fc.record({
            printed: field(CITATION_STORAGE_WIDTHS.text),
            hint: field(CITATION_STORAGE_WIDTHS.courtHint),
            identifier: field(CITATION_STORAGE_WIDTHS.normalizedIdentifier),
            keyInput: field(CITATION_STORAGE_WIDTHS.key),
          }),
          async ({ printed, hint, identifier, keyInput }) => {
            const key = citationKeyOf(keyInput);
            const projected = citationRowOf(decisionId, {
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
              Array.from(hint).length <= CITATION_STORAGE_WIDTHS.courtHint &&
              Array.from(identifier).length <=
                CITATION_STORAGE_WIDTHS.normalizedIdentifier;
            expect(projected.isOk()).toBe(fits);
            if (projected.isErr()) {
              expect(projected.error).toBeInstanceOf(CitationStorageFieldError);
              return;
            }
            const [stored] = await db
              .insert(caseLawCitations)
              .values(projected.value)
              .returning();
            expect(stored).toMatchObject({
              citationText: printed,
              citationKey: key,
              citedCourtHint: hint,
              normalizedIdentifierValue: identifier,
            });
          },
        ),
        { numRuns: 40 },
      );
    });
  });
}
