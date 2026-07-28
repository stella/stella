import { and, eq, isNull, or, sql } from "drizzle-orm";

import {
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusDocumentPayload } from "@/api/lib/corpus-index/core";
import { createCorpusIndexer } from "@/api/lib/corpus-index/core";
import { isRecord } from "@/api/lib/type-guards";

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

const buildDoc = (
  row: IndexableRow,
  { text }: CorpusDocumentPayload,
): Record<string, unknown> => {
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
  granularity: "document",
  buildDocs: (row, payload) => [buildDoc(row, payload)],
  readCorpusText,
  // The scans deliberately carry no ORDER BY. Any pick order makes
  // progress (indexed rows leave the pending set), while ordering by
  // created_at steers the planner onto the created_at index and
  // row-by-row heap filtering; the selective content-hash index is what
  // these scans need.
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
  markIndexedBatch: async (tx, { rows, indexId, now }) => {
    if (rows.length === 0) {
      return new Set();
    }
    // audit: skip — search index maintenance; rebuilds derived state
    // One statement for the whole request; each tuple carries the row's
    // expected pre-state so per-row compare-and-set semantics survive the
    // batching (see the case-law twin).
    const tuples = sql.join(
      rows.map(
        (row) =>
          sql`(${row.id}::uuid, ${row.contentHash}::text, ${row.indexedHash}::text, ${row.updatedAt.toISOString()}::timestamptz)`,
      ),
      sql`, `,
    );
    const marked: unknown = await tx.execute(sql`
      UPDATE ${legislationDocuments} AS d
      SET indexed_hash = v.content_hash,
          indexed_generation = ${indexId},
          indexed_at = ${now.toISOString()}::timestamptz
      FROM (VALUES ${tuples}) AS v(id, content_hash, expected_hash, expected_updated)
      WHERE d.id = v.id
        AND d.indexed_hash IS NOT DISTINCT FROM v.expected_hash
        AND d.updated_at IS NOT DISTINCT FROM v.expected_updated
      RETURNING d.id
    `);
    // The bun-sql driver returns the rows directly; pglite (tests) wraps
    // them in { rows }. Accept both shapes.
    let returned: unknown[] = [];
    if (Array.isArray(marked)) {
      returned = marked;
    } else if (isRecord(marked) && Array.isArray(marked["rows"])) {
      returned = marked["rows"];
    }
    const ids = new Set<SafeId<"legislationDocument">>();
    for (const entry of returned) {
      if (isRecord(entry) && typeof entry["id"] === "string") {
        // SAFETY: RETURNING yields the same uuid values the branded rows
        // supplied in the VALUES tuples, so the brand is preserved.
        ids.add(entry["id"] as SafeId<"legislationDocument">);
      }
    }
    return ids;
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
