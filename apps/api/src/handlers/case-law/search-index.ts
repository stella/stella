import { eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { caseLawDecisions, caseLawSearchDocuments } from "@/api/db/schema";
import { resolveFtsConfig } from "@/api/handlers/case-law/fts-config";
import { captureError } from "@/api/lib/analytics";
import { logger } from "@/api/lib/observability/logger";

import type { DecisionSection } from "./types";

const SEARCH_INDEX_CONCURRENCY = 4;

const sectionsToPlainText = (
  sections: readonly DecisionSection[] | null,
): string => sections?.map((s) => s.text).join(" ") ?? "";

/**
 * Upsert a decision into the `case_law_search_documents` table,
 * computing the tsvector with the language-appropriate regconfig
 * from the `case_law_fts_configs` table.
 *
 * Mirrors the pattern from `lib/search/index-entity.ts` but
 * operates on the global (no tenant column) search table.
 */
export const indexDecision = async (
  decisionId: string,
  scopedDb: ScopedDb,
): Promise<void> => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: decisionId },
      columns: {
        id: true,
        caseNumber: true,
        ecli: true,
        court: true,
        language: true,
        fulltext: true,
        sections: true,
      },
    }),
  );

  if (!decision) {
    return;
  }

  const title = `${decision.caseNumber} — ${decision.court}`;
  const bodyText =
    decision.fulltext ??
    // SAFETY: sections is typed as unknown in Drizzle's JSONB
    // column but is always DecisionSection[] | null when set
    // by the ingestion pipeline (segmenter.ts).
    sectionsToPlainText(decision.sections);

  const searchableText = [
    decision.caseNumber,
    decision.ecli,
    decision.court,
    bodyText,
  ]
    .filter(Boolean)
    .join(" ");

  const fts = await resolveFtsConfig(decision.language);

  const textExpr = fts.useUnaccent
    ? sql`unaccent(coalesce(${title}, '') || ' ' || coalesce(${searchableText}, ''))`
    : sql`coalesce(${title}, '') || ' ' || coalesce(${searchableText}, '')`;

  const tsvExpr = sql`to_tsvector('simple', ${textExpr})`;

  await scopedDb(async (tx) => {
    // Raise statement timeout for the tsvector upsert.
    // to_tsvector + unaccent on very long court decisions is
    // CPU-intensive. SET LOCAL scopes this to the current
    // transaction only; user-facing queries keep the default.
    await tx.execute(sql`SET LOCAL statement_timeout = '15min'`);
    await tx.execute(sql`
    INSERT INTO case_law_search_documents (
      decision_id, title, searchable_text,
      language, regconfig, updated_at, tsv
    ) VALUES (
      ${decision.id},
      ${title},
      ${searchableText},
      ${decision.language},
      ${"simple"},
      now(),
      ${tsvExpr}
    )
    ON CONFLICT (decision_id) DO UPDATE SET
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      language = EXCLUDED.language,
      regconfig = EXCLUDED.regconfig,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
  `);
  });
};

/**
 * Index decisions that are missing from or stale in the search
 * table. Runs as a background loop in the ingestion daemon so
 * the tsvector computation doesn't block the insert path.
 *
 * Returns the number of decisions indexed in this batch.
 */
export const backfillSearchIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
): Promise<number> => {
  // Find decisions that are either missing from the search table
  // or were updated after the search doc was last indexed.
  // ASC order so the backlog clears in insertion order; avoids
  // a "poison pill" where a consistently-failing decision at
  // the top of DESC blocks the rest of the queue.
  const rows = await scopedDb((tx) =>
    tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .leftJoin(
        caseLawSearchDocuments,
        eq(caseLawSearchDocuments.decisionId, caseLawDecisions.id),
      )
      .where(
        sql`${caseLawSearchDocuments.decisionId} IS NULL
         OR ${caseLawDecisions.updatedAt} > ${caseLawSearchDocuments.updatedAt}`,
      )
      .orderBy(sql`${caseLawDecisions.createdAt} ASC`)
      .limit(batchSize),
  );

  const indexRow = async (row: { id: string }): Promise<number> => {
    try {
      await indexDecision(row.id, scopedDb);
      return 1;
    } catch (error) {
      captureError(error, { decisionId: row.id, step: "backfillSearchIndex" });
      logger.error("case_law.search_index.backfill_failed", {
        decisionId: row.id,
      });
      return 0;
    }
  };

  let indexed = 0;
  for (let i = 0; i < rows.length; i += SEARCH_INDEX_CONCURRENCY) {
    const chunk = rows.slice(i, i + SEARCH_INDEX_CONCURRENCY);
    const results = await Promise.all(chunk.map(indexRow));
    for (const result of results) {
      indexed += result;
    }
  }

  return indexed;
};

/**
 * Remove a decision from the search index.
 * Normally handled by CASCADE FK, but useful for
 * explicit cleanup.
 */
export const removeDecisionFromIndex = async (
  decisionId: string,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb((tx) =>
    tx
      .delete(caseLawSearchDocuments)
      .where(eq(caseLawSearchDocuments.decisionId, decisionId)),
  );
};
