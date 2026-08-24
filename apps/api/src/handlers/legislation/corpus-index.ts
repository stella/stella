import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import {
  legislationCorpusIndexDeleteWatermarks,
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusDocumentPayload } from "@/api/lib/corpus-index/core";
import {
  createCorpusIndexer,
  resolveMarkedRowIds,
} from "@/api/lib/corpus-index/core";
import {
  timestampCasToken,
  type TimestampCasToken,
} from "@/api/lib/db/timestamp-cas";
import { readCorpusText } from "@/api/lib/legal-search/corpus-storage";

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
            opstamp: sql`GREATEST(${legislationCorpusIndexDeleteWatermarks.opstamp}, excluded.opstamp)`,
            updatedAt: new Date(),
          },
        });
    });
  },
});

export const loadDocsForBatch = indexer.loadDocsForBatch;
export const backfillLegislationCorpusIndex = indexer.backfill;
export const removeLegislationFromCorpusIndex = indexer.remove;
