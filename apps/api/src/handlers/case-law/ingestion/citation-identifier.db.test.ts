import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  extractCitations,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const DB_TEST_TIMEOUT_MS = 120_000;
let client: PGlite;

beforeAll(
  async () => {
    client = await createTestPglite();
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test(
  "stores an extracted ÚOHS authority decision identifier",
  async () => {
    const db = drizzle({ client });
    const sourceId = createSafeId<"caseLawSource">();
    const decisionId = createSafeId<"caseLawDecision">();
    const citationId = createSafeId<"caseLawCitation">();
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        adapterKey: "authority-test",
        id: sourceId,
        name: "authority-test",
      }),
    );
    await db.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      caseNumber: "1 A 1/2024",
      court: "Test",
      country: "CZE",
      language: "cs",
      languageGroupKey: "authority-test",
    });

    const citation = extractCitations([
      { index: 0, text: "ÚOHS rozhodl pod ÚOHS-S123/2024/VZ." },
    ]).at(0);
    expect(citation?.identifierType).toBe(
      DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER,
    );
    if (citation === undefined) {
      throw new Error("Expected the synthetic ÚOHS citation to be extracted");
    }
    await db.insert(caseLawCitations).values({
      id: citationId,
      citingDecisionId: decisionId,
      citationText: citation.citationText,
      identifierType: citation.identifierType,
      normalizedIdentifierValue: normalizeDecisionIdentifierValue(
        citation.identifierType,
        citation.identifierValue,
      ),
      sectionIndex: citation.sectionIndex,
    });
    const stored = await db
      .select({ type: caseLawCitations.identifierType })
      .from(caseLawCitations);
    expect(stored).toEqual([
      { type: DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);
