import { panic, Result } from "better-result";
import { and, asc, eq, gt, isNull, notExists, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";

import { mapWithConcurrency } from "@stll/concurrency";

import { CorpusSchemaLaneUnavailableError } from "@/api/db/corpus-schema-lane";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSearchBackfillFailures,
  caseLawSearchDocumentPreviewPassages,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveLocalFtsConfig } from "@/api/lib/case-law/local-case-law-config";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { executedRows } from "@/api/lib/db/executed-rows";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import {
  setCorpusBackfillStatementTimeout,
  withDedicatedCorpusBackfillDb,
} from "@/api/lib/legal-search/backfill-statement-timeout";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { writeProjectionWithinTsvectorCeiling } from "@/api/lib/legal-search/tsvector-bounds";
import { logger } from "@/api/lib/observability/logger";
import {
  isPgError,
  isTransientPgConnectionError,
  PG_ERROR,
  pgErrorFields,
} from "@/api/lib/pg-error";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  buildSearchPreviewPassages,
  buildSearchPreviewPassageValueRows,
} from "@/api/lib/search/preview-passages";

const SEARCH_INDEX_CONCURRENCY = 4;
const SEARCH_BACKFILL_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;
const SEARCH_BACKFILL_MAX_ATTEMPTS = SEARCH_BACKFILL_RETRY_DELAYS_MS.length + 1;
const SEARCH_BACKFILL_PARKED_TTL_MS = 24 * 60 * 60_000;
const SEARCH_BACKFILL_DEDUPE_WINDOW_MS = 30_000;
const ERROR_CLASS_MAX_LENGTH = 80;

// oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- both operands remain PostgreSQL timestamptz columns; neither is round-tripped through a JS Date
const matchingSearchBackfillSourceVersion = sql`${caseLawSearchBackfillFailures.sourceUpdatedAt} = ${caseLawDecisions.updatedAt}`;

// A marker is only authoritative for the source version that failed. The
// decision PK probe excludes cooling and parked work without walking the
// failure table ahead of the created-at candidate index.
const eligibleSearchBackfillDecision = sql`NOT EXISTS (
  SELECT 1 FROM ${caseLawSearchBackfillFailures}
  WHERE ${caseLawSearchBackfillFailures.decisionId} = ${caseLawDecisions.id}
    AND ${matchingSearchBackfillSourceVersion}
    AND (
      (${caseLawSearchBackfillFailures.status} = ${CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.PARKED}
        AND ${caseLawSearchBackfillFailures.lastFailedAt} >
          now() - (${SEARCH_BACKFILL_PARKED_TTL_MS}::bigint * interval '1 millisecond'))
      OR ${caseLawSearchBackfillFailures.nextEligibleAt} > now()
    )
)`;

type SearchBackfillFailure = {
  decisionId: SafeId<"caseLawDecision">;
  sourceUpdatedAt: string;
  error: unknown;
};

type SearchBackfillDisposition =
  | { type: "cooldown"; attempts: number }
  | { type: "parked"; attempts: number }
  | { type: "transient"; attempts: number }
  | { type: "superseded" };

const transientSearchBackfillError = (error: unknown): boolean =>
  error instanceof CorpusSchemaLaneUnavailableError ||
  isTransientPgConnectionError(error) ||
  [
    PG_ERROR.LOCK_NOT_AVAILABLE,
    PG_ERROR.QUERY_CANCELED,
    PG_ERROR.DEADLOCK_DETECTED,
    PG_ERROR.SERIALIZATION_FAILURE,
  ].some((code) => isPgError(error, code));

const recordSearchBackfillFailure = async (
  scopedDb: ScopedDb,
  { decisionId, sourceUpdatedAt, error }: SearchBackfillFailure,
): Promise<SearchBackfillDisposition> => {
  const transient = transientSearchBackfillError(error);
  const sameSource = sql`failure.source_updated_at = EXCLUDED.source_updated_at`;
  const sameEpisode = sql`(${sameSource} AND failure.last_failed_at >
    now() - (${SEARCH_BACKFILL_PARKED_TTL_MS}::bigint * interval '1 millisecond'))`;
  const duplicate = sql`(${sameEpisode} AND failure.last_failed_at >
    now() - (${SEARCH_BACKFILL_DEDUPE_WINDOW_MS}::bigint * interval '1 millisecond'))`;
  const nextAttempts = transient
    ? sql`CASE WHEN ${sameEpisode} THEN failure.attempt_count ELSE 0 END`
    : sql`CASE
        WHEN ${duplicate} THEN failure.attempt_count
        WHEN ${sameEpisode}
          THEN LEAST(failure.attempt_count + 1, ${SEARCH_BACKFILL_MAX_ATTEMPTS})
        ELSE 1 END`;
  const nextEligibleAt = sql`CASE
    WHEN ${duplicate} AND NOT ${transient} THEN failure.next_eligible_at
    WHEN ${nextAttempts} >= ${SEARCH_BACKFILL_MAX_ATTEMPTS} THEN NULL
    WHEN ${transient}
      THEN now() + (${SEARCH_BACKFILL_RETRY_DELAYS_MS[0]}::bigint * interval '1 millisecond')
    WHEN ${nextAttempts} = 1
      THEN now() + (${SEARCH_BACKFILL_RETRY_DELAYS_MS[0]}::bigint * interval '1 millisecond')
    ELSE now() + (${SEARCH_BACKFILL_RETRY_DELAYS_MS[1]}::bigint * interval '1 millisecond')
  END`;
  const errorClass = errorTag(error).slice(0, ERROR_CLASS_MAX_LENGTH);
  const row = await scopedDb(async (tx) => {
    // The success writer holds FOR SHARE through the projection and marker
    // delete. This lock serializes that commit with overlapping failures.
    const current = (
      await tx
        .select({
          id: caseLawDecisions.id,
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            eq(caseLawDecisions.id, decisionId),
            sql`${caseLawDecisions.updatedAt} = ${sourceUpdatedAt}::timestamptz`,
            isNull(caseLawDecisions.redactedAt),
            redistributableCaseLawSource,
            publishedCaseLawDecision,
          ),
        )
        .for("update", { of: caseLawDecisions })
        .limit(1)
    ).at(0);
    if (!current) {
      return undefined;
    }
    const currentProjection = await tx
      .select({ id: caseLawSearchDocuments.decisionId })
      .from(caseLawSearchDocuments)
      .innerJoin(
        caseLawSearchDocumentPreviewPassages,
        and(
          eq(
            caseLawSearchDocumentPreviewPassages.decisionId,
            caseLawSearchDocuments.decisionId,
          ),
          eq(
            caseLawSearchDocumentPreviewPassages.generation,
            caseLawSearchDocuments.previewGeneration,
          ),
        ),
      )
      .where(
        and(
          eq(caseLawSearchDocuments.decisionId, decisionId),
          sql`${caseLawSearchDocuments.updatedAt} >= ${sourceUpdatedAt}::timestamptz`,
        ),
      )
      .limit(1);
    if (currentProjection.length > 0) {
      return undefined;
    }
    // audit: skip — durable retry state for a derived public search projection
    return executedRows(
      await tx.execute(sql`INSERT INTO case_law_search_backfill_failures AS failure (
        decision_id, source_updated_at, attempt_count, last_error_class,
        status, next_eligible_at, last_failed_at
      )
      SELECT
        decision.id, decision.updated_at, ${transient ? 0 : 1}, ${errorClass},
        ${CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.COOLDOWN},
        now() + (${SEARCH_BACKFILL_RETRY_DELAYS_MS[0]}::bigint * interval '1 millisecond'),
        now()
      FROM case_law_decisions AS decision
      WHERE decision.id = ${decisionId}
        AND decision.updated_at = ${sourceUpdatedAt}::timestamptz
      ON CONFLICT (decision_id) DO UPDATE SET
        source_updated_at = EXCLUDED.source_updated_at,
        attempt_count = ${nextAttempts},
        last_error_class = CASE
          WHEN ${duplicate} AND NOT ${transient}
            THEN failure.last_error_class
          ELSE EXCLUDED.last_error_class END,
        status = CASE
          WHEN ${transient}
            THEN ${CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.COOLDOWN}
          WHEN ${duplicate} THEN failure.status
          WHEN ${nextAttempts} >= ${SEARCH_BACKFILL_MAX_ATTEMPTS}
            THEN ${CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.PARKED}
          ELSE ${CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.COOLDOWN}
        END,
        next_eligible_at = ${nextEligibleAt},
        last_failed_at = CASE
          WHEN ${duplicate} AND NOT ${transient}
            THEN failure.last_failed_at
          ELSE now() END
      RETURNING attempt_count, status`),
    ).at(0);
  });
  if (row === undefined) {
    return { type: "superseded" };
  }
  if (
    typeof row !== "object" ||
    row === null ||
    !("attempt_count" in row) ||
    typeof row.attempt_count !== "number" ||
    !("status" in row)
  ) {
    return panic("Search backfill failure record is malformed");
  }
  switch (row.status) {
    case CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.COOLDOWN:
      return {
        type: transient ? "transient" : "cooldown",
        attempts: row.attempt_count,
      };
    case CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.PARKED:
      return { type: "parked", attempts: row.attempt_count };
    default:
      return panic("Search backfill failure status is unknown");
  }
};

type ProjectionWriteScope =
  | { type: "shared"; scopedDb: ScopedDb }
  | { type: "dedicated"; scopedDb: ScopedDb };

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
  resolveConfig: typeof resolveLocalFtsConfig = resolveLocalFtsConfig,
  writeScope?: ProjectionWriteScope,
): Promise<Result<void, unknown>> => {
  const projectionWriteScope =
    writeScope ??
    ({ type: "shared", scopedDb } as const satisfies ProjectionWriteScope);
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
          publishedCaseLawDecision,
        ),
      )
      .limit(1),
  );

  if (!decision) {
    // Deleted, gated by source policy, or listing-only: drop any stale
    // projection row. The three probes below carry the same gate, so a row
    // this one refuses is not handed back on the next backfill pass.
    await removeDecisionFromIndex(decisionId, scopedDb);
    return Result.ok(undefined);
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

  const fts = await resolveConfig(decision.language);

  const previewGeneration = Bun.randomUUIDv7();
  const previewPassages = buildSearchPreviewPassages(title, searchableText);

  const writeProjection = async (indexedText: string): Promise<void> => {
    const textExpr = fts.useUnaccent
      ? sql`unaccent(arabic_normalize(coalesce(${title}, '') || ' ' || coalesce(${indexedText}, '')))`
      : sql`arabic_normalize(coalesce(${title}, '') || ' ' || coalesce(${indexedText}, ''))`;
    const tsvExpr = sql`to_tsvector(${fts.regconfig}, ${textExpr})`;

    await projectionWriteScope.scopedDb(async (tx) => {
      if (projectionWriteScope.type === "shared") {
        await setCorpusBackfillStatementTimeout(tx);
      }
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
        await tx
          .delete(caseLawSearchBackfillFailures)
          .where(eq(caseLawSearchBackfillFailures.decisionId, decision.id));
        return;
      }
      await tx.execute(sql`
    INSERT INTO case_law_search_documents (
      decision_id, title, searchable_text,
      language, regconfig, updated_at, tsv
    ) VALUES (
      ${decision.id},
      ${title},
      ${indexedText},
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
      // audit: skip — a successful derived projection clears its retry state
      await tx
        .delete(caseLawSearchBackfillFailures)
        .where(eq(caseLawSearchBackfillFailures.decisionId, decision.id));
    });
  };

  // Preview passages are cut from the whole text before the bound applies: each
  // passage projects into its own small vector, so they never reach the ceiling.
  const projection = await writeProjectionWithinTsvectorCeiling(
    searchableText,
    writeProjection,
  );
  if (Result.isError(projection)) {
    return Result.err(projection.error);
  }
  if (projection.value.bounded) {
    logger.warn("case_law.search_index.tsvector_bounded", {
      decisionId: decision.id,
      "case_law.searchable_text_bytes": Buffer.byteLength(searchableText),
      "case_law.indexed_text_bytes": Buffer.byteLength(
        projection.value.indexedText,
      ),
      ...pgErrorFields(projection.value.cause),
    });
  }
  return Result.ok(undefined);
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
type SearchIndexBackfillResult = {
  found: number;
  indexed: number;
  parked: { type: "parked"; count: number };
};

export const backfillSearchIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
  resolveConfig: typeof resolveLocalFtsConfig = resolveLocalFtsConfig,
  withProjectionDb: typeof withDedicatedCorpusBackfillDb = withDedicatedCorpusBackfillDb,
): Promise<SearchIndexBackfillResult> => {
  // Find decisions that need (re)indexing. ASC order clears the backlog in
  // insertion order; the failure marker lets later rows pass a cooling or
  // parked decision.
  //
  // Split into two queries because Postgres' planner can't use
  // any index for `LEFT JOIN ... WHERE x IS NULL OR y > z` — the
  // OR forces a sequential scan, which timed out hourly once most
  // decisions were already indexed. Each branch below uses its
  // own efficient plan:
  //   - missing: NOT EXISTS scans created_at_idx and probes the
  //     search_documents PK per row, stopping at LIMIT.
  //   - stale: timestamp drift and missing previews have separate
  //     candidate reads; UNION removes IDs selected by both.
  //
  // Reserve a quarter of the batch for stale so re-indexing of
  // updated decisions can't be starved by a sustained backlog of
  // missing-doc inserts.
  const staleReserved = Math.max(1, Math.floor(batchSize / 4));
  const missingLimit = Math.max(1, batchSize - staleReserved);

  const missing = await scopedDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        sourceUpdatedAt: sql<string>`${caseLawDecisions.updatedAt}::text`.as(
          "source_updated_at",
        ),
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          isNull(caseLawDecisions.redactedAt),
          redistributableCaseLawSource,
          publishedCaseLawDecision,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(caseLawSearchDocuments)
              .where(
                eq(caseLawSearchDocuments.decisionId, caseLawDecisions.id),
              ),
          ),
          eligibleSearchBackfillDecision,
        ),
      )
      .orderBy(asc(caseLawDecisions.createdAt))
      .limit(missingLimit),
  );

  const staleLimit = batchSize - missing.length;
  const stale = await scopedDb((tx) => {
    const staleCandidates = (predicate: SQL) =>
      tx
        .select({
          id: caseLawDecisions.id,
          createdAt: caseLawDecisions.createdAt,
          sourceUpdatedAt: sql<string>`${caseLawDecisions.updatedAt}::text`.as(
            "source_updated_at",
          ),
        })
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
            publishedCaseLawDecision,
            predicate,
            eligibleSearchBackfillDecision,
          ),
        )
        .orderBy(asc(caseLawDecisions.createdAt))
        .limit(staleLimit);

    const updated = staleCandidates(
      // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- column-to-column comparison evaluated in Postgres; no JS Date is bound
      gt(caseLawDecisions.updatedAt, caseLawSearchDocuments.updatedAt),
    );
    const missingPreview = staleCandidates(
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
    );
    // A later row in either branch cannot enter the merged first page.
    const candidates = union(updated, missingPreview).as("stale_candidates");
    return tx
      .select({
        id: candidates.id,
        sourceUpdatedAt: candidates.sourceUpdatedAt,
      })
      .from(candidates)
      .orderBy(asc(candidates.createdAt))
      .limit(staleLimit);
  });

  const rows = [...missing, ...stale];

  const indexRow = async (row: {
    id: string;
    sourceUpdatedAt: string;
  }): Promise<number> => {
    const decisionId = brandPersistedCaseLawDecisionId(row.id);
    const indexed = (
      await Result.tryPromise({
        try: async () =>
          await withProjectionDb(
            async (dedicatedDb) =>
              await indexDecision(decisionId, scopedDb, resolveConfig, {
                type: "dedicated",
                scopedDb: dedicatedDb,
              }),
          ),
        catch: (cause) => cause,
      })
    ).andThen((result) => result);
    if (Result.isOk(indexed)) {
      return 1;
    }
    const retry = await recordSearchBackfillFailure(scopedDb, {
      decisionId,
      sourceUpdatedAt: row.sourceUpdatedAt,
      error: indexed.error,
    });
    captureError(indexed.error, {
      decisionId: row.id,
      step: "backfillSearchIndex",
    });
    logger.error("case_law.search_index.backfill_failed", {
      decisionId: row.id,
      retry: retry.type,
      ...("attempts" in retry ? { attempts: retry.attempts } : {}),
      ...errorSystemFields(indexed.error),
      ...pgErrorFields(indexed.error),
    });
    return 0;
  };

  // At most SEARCH_INDEX_CONCURRENCY tsvector upserts in flight, so the
  // backfill never crowds out foreground queries on Postgres.
  const results = await mapWithConcurrency({
    items: rows,
    limit: SEARCH_INDEX_CONCURRENCY,
    operation: indexRow,
  });
  let indexed = 0;
  for (const result of results) {
    indexed += result;
  }

  const parked = await scopedDb(async (tx) => {
    const row = (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(caseLawSearchBackfillFailures)
        .innerJoin(
          caseLawDecisions,
          and(
            eq(caseLawSearchBackfillFailures.decisionId, caseLawDecisions.id),
            matchingSearchBackfillSourceVersion,
          ),
        )
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            eq(
              caseLawSearchBackfillFailures.status,
              CASE_LAW_SEARCH_BACKFILL_FAILURE_STATUS.PARKED,
            ),
            sql`${caseLawSearchBackfillFailures.lastFailedAt} >
              now() - (${SEARCH_BACKFILL_PARKED_TTL_MS}::bigint * interval '1 millisecond')`,
            isNull(caseLawDecisions.redactedAt),
            redistributableCaseLawSource,
            publishedCaseLawDecision,
          ),
        )
    ).at(0);
    return row?.count ?? panic("Search backfill parked count is missing");
  });
  return {
    found: rows.length,
    indexed,
    parked: { type: "parked", count: parked },
  };
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
  // oxlint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb(async (tx) => {
    // audit: skip — search index maintenance; rebuilds derived state
    await tx
      .delete(caseLawSearchDocuments)
      .where(eq(caseLawSearchDocuments.decisionId, decisionId));
    await tx
      .delete(caseLawSearchBackfillFailures)
      .where(eq(caseLawSearchBackfillFailures.decisionId, decisionId));
  });
};
