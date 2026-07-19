import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import {
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import type { SafeId } from "@/api/lib/branded-types";
import { createCorpusIndexer } from "@/api/lib/corpus-index/core";

/**
 * corpus index projection for the `legislation` family. Domain adapter over the
 * shared core (lib/corpus-index/core.ts): supplies the legislation tables, batch
 * queries, and per-document shape. Per-jurisdiction indexes
 * (`legislation_v1_<country>`), license gate in SQL, batch ingest with a
 * per-group commit, audit trail in legislation_index_jobs.
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
  citationAuthority: number;
  citationCount: number;
  textS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
  indexedHash: string | null;
  indexedGeneration: string | null;
  updatedAt: Date;
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
  citationAuthority: legislationDocuments.citationAuthority,
  citationCount: legislationDocuments.citationCount,
  textS3Key: legislationDocuments.textS3Key,
  astS3Key: legislationDocuments.astS3Key,
  contentHash: legislationDocuments.contentHash,
  indexedHash: legislationDocuments.indexedHash,
  indexedGeneration: legislationDocuments.indexedGeneration,
  updatedAt: legislationDocuments.updatedAt,
};

const hasContent = sql`${legislationDocuments.contentHash} IS NOT NULL`;

const buildDoc = (row: IndexableRow, text: string): Record<string, unknown> => {
  // eslint-disable-next-line no-untyped-updates/no-untyped-updates -- corpus index ingest document, not a DB update
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
  buildDoc,
  readCorpusText,
  selectMissing: async (scopedDb, { generation, limit }) =>
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
            or(
              isNull(legislationDocuments.indexedGeneration),
              sql`${legislationDocuments.indexedGeneration} <> (${generation} || '_' || lower(${legislationDocuments.country}))`,
            ),
          ),
        )
        .orderBy(asc(legislationDocuments.createdAt))
        .limit(limit),
    ),
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
            sql`${legislationDocuments.indexedGeneration} = (${generation} || '_' || lower(${legislationDocuments.country}))`,
            sql`${legislationDocuments.indexedHash} IS DISTINCT FROM ${legislationDocuments.contentHash}`,
          ),
        )
        .orderBy(asc(legislationDocuments.createdAt))
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
  markIndexed: async (tx, { row, indexId, now }) => {
    // audit: skip — search index maintenance; rebuilds derived state
    const marked = await tx
      .update(legislationDocuments)
      .set({
        indexedHash: row.contentHash,
        indexedGeneration: indexId,
        indexedAt: now,
      })
      .where(
        and(
          eq(legislationDocuments.id, row.id),
          sql`${legislationDocuments.indexedHash} IS NOT DISTINCT FROM ${row.indexedHash}`,
          sql`${legislationDocuments.updatedAt} IS NOT DISTINCT FROM ${row.updatedAt}`,
        ),
      )
      .returning({ id: legislationDocuments.id });
    return marked.length > 0;
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
});

export const loadDocsForBatch = indexer.loadDocsForBatch;
export const backfillLegislationCorpusIndex = indexer.backfill;
export const removeLegislationFromCorpusIndex = indexer.remove;
