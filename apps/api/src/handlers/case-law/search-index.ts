import { asc, eq, gt, notExists, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { caseLawDecisions, caseLawSearchDocuments } from "@/api/db/schema";
import { resolveFtsConfig } from "@/api/handlers/case-law/fts-config";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
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
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<void> => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
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
  // Find decisions that need (re)indexing. ASC order so the backlog
  // clears in insertion order, avoiding a "poison pill" where a
  // consistently-failing decision at the top of DESC blocks the
  // rest of the queue.
  //
  // Split into two queries because Postgres' planner can't use
  // any index for `LEFT JOIN ... WHERE x IS NULL OR y > z` — the
  // OR forces a sequential scan, which timed out hourly once most
  // decisions were already indexed. Each branch below uses its
  // own efficient plan:
  //   - missing: NOT EXISTS scans created_at_idx and probes the
  //     search_documents PK per row, stopping at LIMIT.
  //   - stale: inner join bounded by LIMIT; the row-level
  //     updated_at comparison is unindexed but only evaluated
  //     against joined rows, not the full table.
  //
  // Reserve a quarter of the batch for stale so re-indexing of
  // updated decisions can't be starved by a sustained backlog of
  // missing-doc inserts.
  const staleReserved = Math.max(1, Math.floor(batchSize / 4));
  const missingLimit = Math.max(1, batchSize - staleReserved);

  const missing = await scopedDb((tx) =>
    tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        notExists(
          tx
            .select({ one: sql`1` })
            .from(caseLawSearchDocuments)
            .where(eq(caseLawSearchDocuments.decisionId, caseLawDecisions.id)),
        ),
      )
      .orderBy(asc(caseLawDecisions.createdAt))
      .limit(missingLimit),
  );

  const staleLimit = batchSize - missing.length;
  const stale = await scopedDb((tx) =>
    tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSearchDocuments,
        eq(caseLawSearchDocuments.decisionId, caseLawDecisions.id),
      )
      .where(gt(caseLawDecisions.updatedAt, caseLawSearchDocuments.updatedAt))
      .orderBy(asc(caseLawDecisions.createdAt))
      .limit(staleLimit),
  );

  const rows = [...missing, ...stale];

  const indexRow = async (row: { id: string }): Promise<number> => {
    try {
      await indexDecision(toSafeId<"caseLawDecision">(row.id), scopedDb);
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
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb((tx) =>
    tx
      .delete(caseLawSearchDocuments)
      .where(eq(caseLawSearchDocuments.decisionId, decisionId)),
  );
};
