import { and, asc, eq, gt, isNull, notExists, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSearchDocumentPreviewPassages,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { setCorpusBackfillStatementTimeout } from "@/api/lib/legal-search/backfill-statement-timeout";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { resolveFtsConfig } from "@/api/lib/legal-search/fts-config";
import { logger } from "@/api/lib/observability/logger";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  buildSearchPreviewPassages,
  buildSearchPreviewPassageValueRows,
} from "@/api/lib/search/preview-passages";

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
  const [decision] = await scopedDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        ecli: caseLawDecisions.ecli,
        identifiers: sql<string[]>`ARRAY(
          SELECT identifier.value
          FROM ${caseLawDecisionIdentifiers} identifier
          WHERE identifier.decision_id = ${caseLawDecisions.id}
          ORDER BY identifier.type, identifier.value
        )`,
        court: caseLawDecisions.court,
        language: caseLawDecisions.language,
        fulltext: caseLawDecisions.fulltext,
        sections: caseLawDecisions.sections,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          isNull(caseLawDecisions.redactedAt),
          redistributableCaseLawSource,
        ),
      )
      .limit(1),
  );

  if (!decision) {
    // Deleted or gated by source policy: drop any stale projection row.
    await removeDecisionFromIndex(decisionId, scopedDb);
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
    ...decision.identifiers,
    decision.court,
    bodyText,
  ]
    .filter(Boolean)
    .join(" ");

  const fts = await resolveFtsConfig(decision.language);

  const textExpr = fts.useUnaccent
    ? sql`unaccent(arabic_normalize(coalesce(${title}, '') || ' ' || coalesce(${searchableText}, '')))`
    : sql`arabic_normalize(coalesce(${title}, '') || ' ' || coalesce(${searchableText}, ''))`;

  const tsvExpr = sql`to_tsvector(${fts.regconfig}, ${textExpr})`;
  const previewGeneration = Bun.randomUUIDv7();
  const previewPassages = buildSearchPreviewPassages(title, searchableText);

  await scopedDb(async (tx) => {
    // Raise statement timeout for the tsvector upsert.
    // to_tsvector + unaccent on very long court decisions is
    // CPU-intensive. The helper scopes the higher timeout to
    // this transaction only; user-facing queries keep the default.
    await setCorpusBackfillStatementTimeout(tx);
    const writableDecision = await tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.id, decision.id),
          isNull(caseLawDecisions.redactedAt),
        ),
      )
      .for("share")
      .limit(1);
    if (!writableDecision.at(0)) {
      // audit: skip — search index maintenance; rebuilds derived state
      await tx
        .delete(caseLawSearchDocuments)
        .where(eq(caseLawSearchDocuments.decisionId, decision.id));
      return;
    }
    await tx.execute(sql`
    INSERT INTO case_law_search_documents (
      decision_id, title, searchable_text,
      language, regconfig, updated_at, tsv
    ) VALUES (
      ${decision.id},
      ${title},
      ${searchableText},
      ${decision.language},
      ${fts.regconfig},
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
    await tx.execute(sql`
      DELETE FROM case_law_search_document_preview_passages
      WHERE decision_id = ${decision.id}
    `);
    await tx.execute(sql`
      INSERT INTO case_law_search_document_preview_passages (
        decision_id, generation, ordinal, content, tsv
      ) VALUES ${buildSearchPreviewPassageValueRows({
        generation: previewGeneration,
        leadingValues: [sql`${decision.id}`],
        passages: previewPassages,
        regconfig: sql`${fts.regconfig}`,
        useUnaccent: fts.useUnaccent,
      })}
    `);
    await tx.execute(sql`
      UPDATE case_law_search_documents
      SET preview_generation = ${previewGeneration}::uuid
      WHERE decision_id = ${decision.id}
    `);
  });
};

/**
 * Index decisions that are missing from or stale in the search
 * table. Runs as a background loop in the ingestion daemon so
 * the tsvector computation doesn't block the insert path.
 *
 * Returns how many decisions the probe found and how many of them
 * indexed successfully; the caller schedules its next poll off `found`
 * (an all-failing batch is pending work, not an idle projection).
 */
type SearchIndexBackfillResult = { found: number; indexed: number };

export const backfillSearchIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
): Promise<SearchIndexBackfillResult> => {
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
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          isNull(caseLawDecisions.redactedAt),
          redistributableCaseLawSource,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(caseLawSearchDocuments)
              .where(
                eq(caseLawSearchDocuments.decisionId, caseLawDecisions.id),
              ),
          ),
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
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          isNull(caseLawDecisions.redactedAt),
          redistributableCaseLawSource,
          or(
            // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- column-to-column comparison evaluated in Postgres; no JS Date is bound
            gt(caseLawDecisions.updatedAt, caseLawSearchDocuments.updatedAt),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(caseLawSearchDocumentPreviewPassages)
                .where(
                  and(
                    eq(
                      caseLawSearchDocumentPreviewPassages.decisionId,
                      caseLawDecisions.id,
                    ),
                    eq(
                      caseLawSearchDocumentPreviewPassages.generation,
                      caseLawSearchDocuments.previewGeneration,
                    ),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(asc(caseLawDecisions.createdAt))
      .limit(staleLimit),
  );

  const rows = [...missing, ...stale];

  const indexRow = async (row: { id: string }): Promise<number> => {
    try {
      await indexDecision(brandPersistedCaseLawDecisionId(row.id), scopedDb);
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
    // oxlint-disable-next-line no-await-in-loop, no-db-await-in-loop/no-db-await-in-loop -- bounded concurrency: each SEARCH_INDEX_CONCURRENCY chunk drains before the next so tsvector upserts don't overwhelm Postgres
    const results = await Promise.all(chunk.map(indexRow));
    for (const result of results) {
      indexed += result;
    }
  }

  return { found: rows.length, indexed };
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
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — search index maintenance; rebuilds derived state
    return tx
      .delete(caseLawSearchDocuments)
      .where(eq(caseLawSearchDocuments.decisionId, decisionId));
  });
};
