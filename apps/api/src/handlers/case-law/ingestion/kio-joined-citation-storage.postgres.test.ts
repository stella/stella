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
import { deriveDecisionReferences } from "@/api/handlers/case-law/citations/decision-references";
import {
  bareCitationKey,
  extractCitations,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { citationRowOf } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import { createSafeId } from "@/api/lib/branded-types";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("joined citation storage", () => {
    test("requires an explicitly enabled Postgres database", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("joined citation storage", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const sourceId = createSafeId<"caseLawSource">();
    cleanUp(async () => {
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });
    test("generated joined runs write every docket through the citation row projection", async () => {
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `joined-${sourceId}`,
        name: "joined fixture",
      });
      const citingDecisionId = createSafeId<"caseLawDecision">();
      await db.insert(caseLawDecisions).values({
        id: citingDecisionId,
        sourceId,
        caseNumber: "joined fixture",
        court: "fixture court",
        country: "CZE",
        language: "cs",
      });
      await assertProperty(
        "generated joined runs write every docket through the citation row projection",
        fc.asyncProperty(
          fc.integer({ min: 12, max: 70 }),
          fc.integer({ min: 1000, max: 9000 }),
          fc.constantFrom(", ", ",\n"),
          async (count, first, separator) => {
            const dockets = Array.from(
              { length: count },
              (_, index) => `KIO ${first + index}/25`,
            );
            const sections = [
              { index: 0, text: `por. wyroki ${dockets.join(separator)}.` },
            ];
            const citations = extractCitations(sections);
            const { references } = deriveDecisionReferences({
              citingDecisionId,
              citations,
              proceduralKeys: new Set(),
              sections,
            });
            expect(references.map(({ printed }) => printed)).toEqual(dockets);
            const stored = await db
              .insert(caseLawCitations)
              .values(
                references.map((reference) =>
                  citationRowOf(citingDecisionId, {
                    reference,
                    verdict: null,
                  }).unwrap(),
                ),
              )
              .returning();
            expect(
              stored.map(({ citationText }) => citationText).toSorted(),
            ).toEqual(dockets.toSorted());
            for (const docket of dockets) {
              expect(
                stored.find(({ citationText }) => citationText === docket),
              ).toMatchObject({
                citationKey: bareCitationKey(docket),
                normalizedIdentifierValue: normalizeDecisionIdentifierValue(
                  DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                  docket,
                ),
              });
            }
          },
        ),
        { numRuns: 20 },
      );
    });
  });
}
