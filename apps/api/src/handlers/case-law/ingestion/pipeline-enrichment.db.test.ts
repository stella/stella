import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const corpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("Inline fixture must not transfer packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

test("weak publication enrichment preserves its row and distinguishes full cohort siblings", async () => {
  const client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  const sourceId = createSafeId<"caseLawSource">();
  const publication = (
    fulltext: string,
    sourceUrl = "https://example.org/publication/first",
  ) =>
    plainTextIngestionResult({
      caseNumber: "0Pu/1/2025",
      court: "Mestský súd Košice",
      country: "SVK",
      language: "sk",
      decisionDate: "2025-04-18",
      decisionType: "Uznesenie",
      sourceUrl,
      fulltext,
      rawHash: `${sourceUrl}:${fulltext}`,
      metadata: {},
      documentAst: EMPTY_AST,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    });
  let observationOrder = 0n;
  const ingest = async (input: ReturnType<typeof publication>) => {
    observationOrder += 1n;
    const outcome = await processDecision({
      input,
      scopedDb,
      sourceId,
      corpus,
      observationOrder,
      observedAt: new Date("2026-10-29T08:00:00Z"),
    });
    expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  };
  const stored = async () =>
    await db
      .select({
        id: caseLawDecisions.id,
        text: caseLawDecisions.fulltext,
        publicationHash: caseLawDecisions.fallbackPublicationHash,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId));
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `enrichment-${sourceId}`,
      name: "Enrichment fixture",
    });
    await ingest(publication(""));
    const before = await stored();
    expect(before).toHaveLength(1);
    const original =
      before.at(0) ?? panic("Metadata observation must be stored");
    await ingest(publication("Prvé uznesenie."));
    expect(await stored()).toEqual([
      {
        id: original.id,
        publicationHash: original.publicationHash,
        text: "Prvé uznesenie.",
      },
    ]);
    await ingest(publication("Prvé uznesenie."));
    expect(await stored()).toHaveLength(1);
    await ingest(publication(""));
    await ingest(publication("Prvé uznesenie."));
    expect(await stored()).toHaveLength(1);
    // This isolated snapshot models the contract release; the expansion still retains this index.
    await db.execute(
      sql`DROP INDEX case_law_decisions_source_case_lang_null_idx`,
    );
    await ingest(publication("", "https://example.org/publication/second"));
    await ingest(
      publication("Druhé uznesenie.", "https://example.org/publication/second"),
    );
    await ingest(publication("Tretie uznesenie."));
    const siblings = await stored();
    expect(siblings).toHaveLength(3);
    expect(new Set(siblings.map(({ id }) => id)).size).toBe(3);
    expect(siblings.find(({ id }) => id === before.at(0)?.id)?.text).toBe(
      "Prvé uznesenie.",
    );
    await ingest(
      publication("Druhé uznesenie.", "https://example.org/publication/second"),
    );
    await ingest(publication("Tretie uznesenie."));
    expect(await stored()).toHaveLength(3);
  } finally {
    await client.close();
  }
});
