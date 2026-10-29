import { Result } from "better-result";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  decisionFallbackColumns,
  decisionStorageIdentity,
  decisionStorageIdentityMatch,
} from "@/api/lib/case-law/fallback-decision-identity";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { createTestPglite } from "@/api/tests/pglite-test-db";

test("weak storage matches content without merging same-day same-type cohort members", async () => {
  const client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const sourceId = createSafeId<"caseLawSource">();
  const publication = (fulltext: string, court = "Mestský súd Košice") =>
    plainTextIngestionResult({
      caseNumber: "0Pu/1/2025",
      country: "SVK",
      language: "sk",
      court,
      decisionDate: "2025-04-18",
      decisionType: "Uznesenie",
      fulltext,
      rawHash: "fixture",
      metadata: {},
      documentAst: EMPTY_AST,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    });
  const insert = async (input: ReturnType<typeof publication>) => {
    const identity = decisionStorageIdentity(input);
    const id = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values({
      id,
      sourceId,
      caseNumber: input.caseNumber,
      country: input.country,
      court: input.court,
      language: input.language,
      decisionDate: input.decisionDate,
      decisionType: input.decisionType,
      ...decisionFallbackColumns(identity),
    });
    return id;
  };
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "fallback-content-fixture",
      name: "Fallback content fixture",
    });
    // This private snapshot models the later contract cutover. The shipped
    // expansion retains this index, covered by the real-PostgreSQL fixture.
    await db.execute(
      sql`DROP INDEX case_law_decisions_source_case_lang_null_idx`,
    );
    const first = publication("Prvé uznesenie.");
    const sibling = publication("Druhé uznesenie toho istého dňa.");
    const otherCourt = publication("Prvé uznesenie.", "Okresný súd Bardejov");
    const firstId = await insert(first);
    const siblingId = await insert(sibling);
    const otherCourtId = await insert(otherCourt);
    for (const [input, id] of [
      [first, firstId],
      [sibling, siblingId],
      [otherCourt, otherCourtId],
    ] as const) {
      // db-await-in-loop: every actual stored cohort member must resolve independently.
      const row = await db.query.caseLawDecisions.findFirst({
        where: {
          sourceId: { eq: sourceId },
          ...decisionStorageIdentityMatch(decisionStorageIdentity(input)),
        },
        columns: { id: true },
      });
      expect(row?.id).toBe(id);
    }
    const duplicate = await Result.tryPromise({
      try: async () => await insert(first),
      catch: (cause: unknown) => cause,
    });
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isErr()) {
      expect(getPgErrorCode(duplicate.error)).toBe(PG_ERROR.UNIQUE_VIOLATION);
    }
    expect(
      await db.select({ id: caseLawDecisions.id }).from(caseLawDecisions),
    ).toHaveLength(3);
  } finally {
    await client.close();
  }
});
