import { Result } from "better-result";
import {
  and,
  count,
  eq,
  exists,
  isNotNull,
  isNull,
  lte,
  min,
  sql,
} from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationCorpusIndexDeleteWatermarks,
  legislationCorpusIndexPendingDeletes,
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import type { SafeId } from "@/api/lib/branded-types";
import { DELETE_SETTLEMENT_STALE_MS } from "@/api/lib/corpus-index/census";
import type { CorpusDocumentPayload } from "@/api/lib/corpus-index/core";
import {
  createCorpusIndexer,
  resolveMarkedRowIds,
} from "@/api/lib/corpus-index/core";
import {
  timestampCasToken,
  type TimestampCasToken,
} from "@/api/lib/db/timestamp-cas";
import {
  CorpusIndexError,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import { readCorpusText } from "@/api/lib/legal-search/corpus-storage";
import { logger } from "@/api/lib/observability/logger";

/**
 * corpus index projection for the `legislation` family. Domain adapter over the
 * shared core (lib/corpus-index/core.ts): supplies the legislation tables, batch
 * queries, and per-document shape. Per-jurisdiction indexes
 * (`legislation_v1_<country>`), license gate in SQL, batch ingest with a
 * per-group commit, audit trail in legislation_index_jobs.
 *
 * Indexed at document granularity, unlike case law: a legislation row is
 * already one provision or article version, so it is the passage. Splitting it
 * further would fragment a rule across search documents that are only
 * meaningful together. If a jurisdiction starts delivering whole codes as one
 * row, revisit this by switching the granularity here — the shared core, the
 * chunker, and the read path already handle both layouts.
 */

type IndexableRow = {
  id: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  eli: string;
  title: string;
  country: string;
  language: string;
  documentType: string | null;
  status: string;
  effectiveDate: string | null;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  citationAuthority: number;
  citationCount: number;
  textS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
  indexedHash: string | null;
  indexedGeneration: string | null;
  updatedAtToken: TimestampCasToken;
};

// Deliberately excludes `fulltext` (see the case-law indexer): the fallback
// text for rows without a canonical S3 object is fetched lazily per document
// so the batch SELECT never drags megabytes of text through one transaction.
const SELECT_COLUMNS = {
  id: legislationDocuments.id,
  sourceId: legislationDocuments.sourceId,
  eli: legislationDocuments.eli,
  title: legislationDocuments.title,
  country: legislationDocuments.country,
  language: legislationDocuments.language,
  documentType: legislationDocuments.documentType,
  status: legislationDocuments.status,
  effectiveDate: legislationDocuments.effectiveDate,
  versionValidFrom: legislationDocuments.versionValidFrom,
  versionValidTo: legislationDocuments.versionValidTo,
  citationAuthority: legislationDocuments.citationAuthority,
  citationCount: legislationDocuments.citationCount,
  textS3Key: legislationDocuments.textS3Key,
  astS3Key: legislationDocuments.astS3Key,
  contentHash: legislationDocuments.contentHash,
  indexedHash: legislationDocuments.indexedHash,
  indexedGeneration: legislationDocuments.indexedGeneration,
  updatedAtToken: timestampCasToken(legislationDocuments.updatedAt),
};

const hasContent = sql`${legislationDocuments.contentHash} IS NOT NULL`;

const buildDoc = (
  row: IndexableRow,
  { text }: CorpusDocumentPayload,
): Record<string, unknown> => {
  const doc: Record<string, unknown> = {
    document_id: row.id,
    jurisdiction: row.country,
    source: row.sourceId,
    language: row.language,
    title: row.title,
    text,
    status: row.status,
    eli: row.eli,
    citation_authority: row.citationAuthority,
    citation_count: row.citationCount,
  };
  if (row.documentType !== null) {
    doc["document_type"] = row.documentType;
  }
  const dateForYear = row.effectiveDate ?? row.versionValidFrom;
  if (row.effectiveDate !== null) {
    doc["effective_date"] = row.effectiveDate;
  }
  // The validity window, verbatim and half-open `[from, to)`. Each bound is
  // written only when the source published it: an absent `version_valid_to` is
  // what marks the current consolidation, so writing a stand-in date would
  // close a window the source left open.
  if (row.versionValidFrom !== null) {
    doc["version_valid_from"] = row.versionValidFrom;
  }
  if (row.versionValidTo !== null) {
    doc["version_valid_to"] = row.versionValidTo;
  }
  if (dateForYear !== null) {
    doc["year"] = Number(dateForYear.slice(0, 4));
  }
  if (row.textS3Key !== null) {
    doc["canonical_text_key"] = row.textS3Key;
  }
  if (row.astS3Key !== null) {
    doc["canonical_ast_key"] = row.astS3Key;
  }
  return doc;
};

const indexer = createCorpusIndexer<"legislationDocument", IndexableRow>({
  family: "legislation",
  captureStep: "backfillLegislationCorpusIndex.loadText",
  granularity: "document",
  buildDocs: (row, payload) => [buildDoc(row, payload)],
  readCorpusText,
  // The scans deliberately carry no ORDER BY. Any pick order makes
  // progress (indexed rows leave the pending set), while ordering by
  // created_at steers the planner onto the created_at index and
  // row-by-row heap filtering; the selective content-hash index is what
  // these scans need.
  selectMissing: async (scopedDb, { generation, limit }) => {
    // Hash-null rows are the durable pending set: new rows and every refresh
    // clear this field while retaining the old generation pointer needed to
    // delete a moved jurisdiction copy. The older-generation arm is only
    // non-empty across a generation cutover.
    const fresh = await scopedDb((tx) =>
      tx
        .select(SELECT_COLUMNS)
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
        )
        .where(
          and(
            hasContent,
            redistributableLegislationSource,
            isNull(legislationDocuments.indexedHash),
          ),
        )
        .limit(limit),
    );
    if (fresh.length >= limit) {
      return fresh;
    }
    const carried = await scopedDb((tx) =>
      tx
        .select(SELECT_COLUMNS)
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
        )
        .where(
          and(
            hasContent,
            redistributableLegislationSource,
            isNotNull(legislationDocuments.indexedHash),
            sql`${legislationDocuments.indexedGeneration} <> (${generation} || '_' || lower(${legislationDocuments.country}))`,
          ),
        )
        .limit(limit - fresh.length),
    );
    // A row read as never-indexed by the first arm can be marked by a
    // concurrent build under another generation before the second arm
    // runs, which would select it again; the ingest is append-only, so
    // the same id must not be submitted twice.
    const seen = new Set(fresh.map((row) => row.id));
    return [...fresh, ...carried.filter((row) => !seen.has(row.id))];
  },
  selectStale: async (scopedDb, { generation, limit }) =>
    await scopedDb((tx) =>
      tx
        .select(SELECT_COLUMNS)
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
        )
        .where(
          and(
            hasContent,
            redistributableLegislationSource,
            isNotNull(legislationDocuments.indexedHash),
            sql`${legislationDocuments.indexedGeneration} = (${generation} || '_' || lower(${legislationDocuments.country}))`,
            sql`${legislationDocuments.indexedHash} IS DISTINCT FROM ${legislationDocuments.contentHash}`,
          ),
        )
        .limit(limit),
    ),
  fetchFulltext: async (scopedDb, id) => {
    const fallback = await scopedDb((tx) =>
      tx
        .select({ fulltext: legislationDocuments.fulltext })
        .from(legislationDocuments)
        .where(eq(legislationDocuments.id, id))
        .limit(1),
    );
    return fallback.at(0)?.fulltext ?? null;
  },
  generationProjectionIndexIds: () => [],
  markIndexedBatch: async (tx, { rows, indexId, now }) => {
    if (rows.length === 0) {
      return new Set();
    }
    // audit: skip — search index maintenance; rebuilds derived state
    // One statement for the whole request; each tuple carries the row's
    // expected pre-state so per-row compare-and-set semantics survive the
    // batching. Generation is part of the pre-state and updated_at is left
    // alone (see the case-law twin for the reasoning).
    const tuples = sql.join(
      rows.map(
        (row) =>
          sql`(${row.id}::uuid, ${row.contentHash}::text, ${row.indexedHash}::text, ${row.indexedGeneration}::text, ${row.updatedAtToken}::timestamptz)`,
      ),
      sql`, `,
    );
    const marked: unknown = await tx.execute(sql`
      UPDATE ${legislationDocuments} AS d
      SET indexed_hash = v.content_hash,
          indexed_generation = ${indexId},
          indexed_at = ${now.toISOString()}::timestamptz
      FROM (VALUES ${tuples}) AS v(id, content_hash, expected_hash, expected_generation, expected_updated)
      WHERE d.id = v.id
        AND d.indexed_hash IS NOT DISTINCT FROM v.expected_hash
        AND d.indexed_generation IS NOT DISTINCT FROM v.expected_generation
        AND d.updated_at IS NOT DISTINCT FROM v.expected_updated
      RETURNING d.id
    `);
    return resolveMarkedRowIds(marked, rows);
  },
  insertSucceededJobs: async (tx, { rows, indexId }) => {
    // audit: skip — append-only index-job rows ARE the indexing audit trail
    await tx.insert(legislationIndexJobs).values(
      rows.map((row) => ({
        documentId: row.id,
        generation: indexId,
        operation: "index" as const,
        status: "succeeded" as const,
        contentHash: row.contentHash,
      })),
    );
  },
  recordJobs: async (scopedDb, jobs, generation) => {
    if (jobs.length === 0) {
      return;
    }
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    await scopedDb((tx) => {
      // audit: skip — append-only index-job rows ARE the indexing audit trail
      return tx.insert(legislationIndexJobs).values(
        jobs.map((job) => ({
          documentId: job.entityId,
          generation,
          operation: job.operation,
          status: job.status,
          contentHash: job.contentHash,
          errorMessage: job.errorMessage ?? null,
        })),
      );
    });
  },
  recordDeleteJobs: async (scopedDb, { indexId, jobs, opstamp }) => {
    if (jobs.length === 0) {
      return;
    }
    await scopedDb(async (tx) => {
      // audit: skip — append-only index-job rows ARE the indexing audit trail
      await tx.insert(legislationIndexJobs).values(
        jobs.map((job) => ({
          documentId: job.entityId,
          generation: indexId,
          operation: job.operation,
          status: job.status,
          contentHash: job.contentHash,
          errorMessage: job.errorMessage ?? null,
        })),
      );
      if (opstamp === null) {
        return;
      }
      // audit: skip — derived engine-settlement watermark; the job rows above
      // are the document-level audit trail for the same remote effect
      await tx
        .insert(legislationCorpusIndexDeleteWatermarks)
        .values({ indexId, opstamp })
        .onConflictDoUpdate({
          target: legislationCorpusIndexDeleteWatermarks.indexId,
          set: {
            opstamp: sql`GREATEST(
              ${legislationCorpusIndexDeleteWatermarks.opstamp},
              excluded.opstamp
            )`,
            updatedAt: new Date(),
          },
        });
      // audit: skip — bounded settlement state; append-only index jobs above
      // remain the audit trail after settled rows are removed by reconciliation
      await tx
        .insert(legislationCorpusIndexPendingDeletes)
        .values(
          jobs.map((job) => ({
            indexId,
            documentId: job.entityId,
            opstamp,
          })),
        )
        .onConflictDoUpdate({
          target: [
            legislationCorpusIndexPendingDeletes.indexId,
            legislationCorpusIndexPendingDeletes.documentId,
          ],
          set: {
            opstamp: sql`GREATEST(
              ${legislationCorpusIndexPendingDeletes.opstamp},
              excluded.opstamp
            )`,
          },
        });
    });
  },
});

export type LegislationDeleteSettlement = {
  indexId: string;
  pendingDocuments: number;
  stale: boolean;
  settled: boolean;
};

/**
 * Reconcile one oldest legislation delete backlog. Delete tasks apply to
 * Quickwit splits asynchronously, so an accepted task cannot clear its
 * durable ownership until every published split reaches the task opstamp.
 * One index per call bounds engine and database work; the daemon calls this
 * every index cycle and drains every remaining backlog over time.
 */
// audit: skip — scheduler-owned, derived corpus-index settlement state; the
// append-only index-job rows retain the document-level audit trail.
export const reconcileNextLegislationCorpusIndexDelete = async (
  scopedDb: ScopedDb,
): Promise<Result<LegislationDeleteSettlement | null, CorpusIndexError>> =>
  await Result.tryPromise({
    try: async () => {
      const next = (
        await scopedDb((tx) =>
          tx
            .select({
              indexId: legislationCorpusIndexDeleteWatermarks.indexId,
              opstamp: legislationCorpusIndexDeleteWatermarks.opstamp,
            })
            .from(legislationCorpusIndexDeleteWatermarks)
            .where(
              exists(
                tx
                  .select({
                    indexId: legislationCorpusIndexPendingDeletes.indexId,
                  })
                  .from(legislationCorpusIndexPendingDeletes)
                  .where(
                    eq(
                      legislationCorpusIndexPendingDeletes.indexId,
                      legislationCorpusIndexDeleteWatermarks.indexId,
                    ),
                  )
                  .limit(1),
              ),
            )
            .orderBy(
              sql`${legislationCorpusIndexDeleteWatermarks.lastCheckedAt} NULLS FIRST`,
            )
            .limit(1),
        )
      ).at(0);
      if (next === undefined) {
        return null;
      }
      await scopedDb(async (tx) => {
        // audit: skip — scheduler-owned, derived settlement scheduling state
        await tx
          .update(legislationCorpusIndexDeleteWatermarks)
          .set({ lastCheckedAt: new Date() })
          .where(
            eq(legislationCorpusIndexDeleteWatermarks.indexId, next.indexId),
          );
      });

      const settlement = await getCorpusIndexClient().readDeleteSettlement(
        next.indexId,
        next.opstamp,
      );
      if (settlement.isErr()) {
        throw settlement.error;
      }
      const appliedOpstamp =
        settlement.value.publishedSplits === 0
          ? next.opstamp
          : settlement.value.minAppliedOpstamp;
      const pending = await scopedDb(async (tx) => {
        if (appliedOpstamp !== null) {
          // audit: skip — bounded derived settlement state
          await tx
            .delete(legislationCorpusIndexPendingDeletes)
            .where(
              and(
                eq(legislationCorpusIndexPendingDeletes.indexId, next.indexId),
                lte(
                  legislationCorpusIndexPendingDeletes.opstamp,
                  appliedOpstamp,
                ),
              ),
            );
        }
        return await tx
          .select({
            oldestPendingAt: min(
              legislationCorpusIndexPendingDeletes.createdAt,
            ),
            pendingDocuments: count(),
          })
          .from(legislationCorpusIndexPendingDeletes)
          .where(
            eq(legislationCorpusIndexPendingDeletes.indexId, next.indexId),
          );
      });
      const state = pending.at(0);
      const oldestPendingAt = state?.oldestPendingAt ?? null;
      const pendingDocuments = state?.pendingDocuments ?? 0;
      return {
        indexId: next.indexId,
        pendingDocuments,
        stale:
          oldestPendingAt !== null &&
          Date.now() - oldestPendingAt.getTime() >= DELETE_SETTLEMENT_STALE_MS,
        settled: pendingDocuments === 0,
      };
    },
    catch: (error) =>
      error instanceof CorpusIndexError
        ? error
        : new CorpusIndexError({
            message:
              error instanceof Error
                ? error.message
                : "legislation delete settlement failed",
            cause: error,
          }),
  });

export const loadDocsForBatch = indexer.loadDocsForBatch;
export const backfillLegislationCorpusIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
  generation: string,
  options: { readConcurrency?: number } = {},
): Promise<number> => {
  const indexed = await indexer.backfill(
    scopedDb,
    batchSize,
    generation,
    options,
  );
  const settlement = await reconcileNextLegislationCorpusIndexDelete(scopedDb);
  if (settlement.isErr()) {
    logger.warn("legislation.corpus_index.delete_settlement_unavailable", {
      "error.type": settlement.error._tag,
    });
  } else if (settlement.value?.stale) {
    logger.warn("legislation.corpus_index.delete_settlement_stalled", {
      indexId: settlement.value.indexId,
      pendingDocuments: settlement.value.pendingDocuments,
    });
  }
  return indexed;
};
export const removeLegislationFromCorpusIndex = indexer.remove;
