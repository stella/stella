import { Result } from "better-result";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getCorpusIndexClient,
  type CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

/**
 * corpus index projection for the `legislation` family. Mirrors
 * case-law/corpus-index.ts: per-jurisdiction indexes
 * (`legislation_v1_<country>`), license gate in SQL, batch ingest with a
 * per-group commit, audit trail in legislation_index_jobs.
 */

const INDEX_CONCURRENCY = 4;

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

const ensuredIndexes = new Set<string>();

const ensureIndex = async (
  indexId: string,
): Promise<Result<void, CorpusIndexError>> => {
  if (ensuredIndexes.has(indexId)) {
    return Result.ok(undefined);
  }
  const client = getCorpusIndexClient();
  const exists = await client.indexExists(indexId);
  if (exists.isErr()) {
    return Result.err(exists.error);
  }
  if (!exists.value) {
    const created = await client.createIndex(
      corpusIndexConfig("legislation", indexId),
    );
    if (created.isErr()) {
      return Result.err(created.error);
    }
  }
  ensuredIndexes.add(indexId);
  return Result.ok(undefined);
};

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

/** Lazy Postgres fulltext fallback for rows without a canonical S3 object. */
type FetchFulltext = (
  id: SafeId<"legislationDocument">,
) => Promise<string | null>;

const loadText = async (
  row: IndexableRow,
  fetchFulltext: FetchFulltext,
): Promise<string> => {
  // Match the case-law indexer: a read failure propagates so the caller
  // can isolate this document (record it failed, drop it from the batch) and
  // retry it next cycle, rather than committing indexedHash = contentHash for
  // fallback or empty text.
  if (row.textS3Key !== null) {
    return await readCorpusText(row.textS3Key);
  }
  // Only rows without a corpus object read their Postgres fulltext, one
  // small bounded query per such row; the batch SELECT never carries text.
  return (await fetchFulltext(row.id)) ?? "";
};

type LoadedBatch = {
  docs: { row: IndexableRow; doc: Record<string, unknown> }[];
  readFailures: { indexId: string; job: JobInput; cause: unknown }[];
};

type LoadDocsForBatchOptions = {
  generation: string;
  fetchFulltext: FetchFulltext;
  /** Override the per-row text load (test seam). */
  readText?: (row: IndexableRow) => Promise<string>;
};

/**
 * Build each row's index document from its canonical text, isolating per-row
 * read failures. Mirrors the case-law indexer: a bounded corpus read that
 * times out or errors fails only its own document (recorded failed, dropped
 * from the batch, retried next cycle) while its batch-mates still commit.
 */
export const loadDocsForBatch = async (
  rows: readonly IndexableRow[],
  { generation, fetchFulltext, readText }: LoadDocsForBatchOptions,
): Promise<LoadedBatch> => {
  const loadRowText =
    readText ??
    (async (row: IndexableRow) => await loadText(row, fetchFulltext));
  const docs: LoadedBatch["docs"] = [];
  const readFailures: LoadedBatch["readFailures"] = [];
  for (let i = 0; i < rows.length; i += INDEX_CONCURRENCY) {
    const chunk = rows.slice(i, i + INDEX_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- bounded concurrency: drain one INDEX_CONCURRENCY chunk before loading the next so S3 reads stay capped
    const built = await Promise.all(
      chunk.map(async (row) => {
        try {
          return {
            ok: true as const,
            row,
            doc: buildDoc(row, await loadRowText(row)),
          };
        } catch (error) {
          return { ok: false as const, row, error };
        }
      }),
    );
    for (const entry of built) {
      if (entry.ok) {
        docs.push({ row: entry.row, doc: entry.doc });
        continue;
      }
      readFailures.push({
        indexId: corpusIndexId(generation, entry.row.country),
        cause: entry.error,
        job: {
          documentId: entry.row.id,
          contentHash: entry.row.contentHash,
          operation: "index",
          status: "failed",
          errorMessage: (entry.error instanceof Error
            ? entry.error.message
            : String(entry.error)
          ).slice(0, 2048),
        },
      });
    }
  }
  return { docs, readFailures };
};

/**
 * Fail loud, continue: record isolated per-document read failures. Mirrors the
 * case-law indexer — captures the underlying (tagged) error with jurisdiction/
 * generation context (never document text) and writes a failed index job under
 * each affected jurisdiction index so a later cycle retries the rows.
 */
const recordReadFailures = async (
  scopedDb: ScopedDb,
  readFailures: LoadedBatch["readFailures"],
  generation: string,
): Promise<void> => {
  const firstFailure = readFailures.at(0);
  if (!firstFailure) {
    return;
  }
  captureError(firstFailure.cause, {
    step: "backfillLegislationCorpusIndex.loadText",
    generation,
    failed: String(readFailures.length),
  });
  const failuresByIndex = new Map<string, JobInput[]>();
  for (const { indexId, job } of readFailures) {
    const existing = failuresByIndex.get(indexId);
    if (existing) {
      existing.push(job);
    } else {
      failuresByIndex.set(indexId, [job]);
    }
  }
  for (const [indexId, jobs] of failuresByIndex) {
    // oxlint-disable-next-line no-await-in-loop -- sequential per-index audit writes preserve job ordering
    await recordJobs(scopedDb, jobs, indexId);
  }
};

export const backfillLegislationCorpusIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
  generation: string,
): Promise<number> => {
  const staleReserved = Math.max(1, Math.floor(batchSize / 4));
  const missingLimit = Math.max(1, batchSize - staleReserved);

  const missing = await scopedDb((tx) =>
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
      .limit(missingLimit),
  );

  const staleLimit = batchSize - missing.length;
  const stale =
    staleLimit <= 0
      ? []
      : await scopedDb((tx) =>
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
            .limit(staleLimit),
        );

  const rows: IndexableRow[] = [...missing, ...stale];
  if (rows.length === 0) {
    return 0;
  }

  // A per-document read failure fails only that document; record it and let
  // the rest still commit.
  const fetchFulltext: FetchFulltext = async (id) => {
    const fallback = await scopedDb((tx) =>
      tx
        .select({ fulltext: legislationDocuments.fulltext })
        .from(legislationDocuments)
        .where(eq(legislationDocuments.id, id))
        .limit(1),
    );
    return fallback.at(0)?.fulltext ?? null;
  };
  const { docs, readFailures } = await loadDocsForBatch(rows, {
    generation,
    fetchFulltext,
  });
  await recordReadFailures(scopedDb, readFailures, generation);

  const groups = new Map<string, typeof docs>();
  for (const entry of docs) {
    const indexId = corpusIndexId(generation, entry.row.country);
    const group = groups.get(indexId);
    if (group) {
      group.push(entry);
    } else {
      groups.set(indexId, [entry]);
    }
  }

  const now = new Date();
  let indexed = 0;
  let firstError: CorpusIndexError | null = null;

  for (const [indexId, group] of groups) {
    // Ingest appends; it never replaces. Before re-ingesting, delete the
    // previously indexed copy from wherever it lives (the same index for
    // a content refresh, another jurisdiction index for a corrected
    // country), or stale copies keep matching old text. Same generation
    // only: generation rebuilds replace whole indexes. Engine delete
    // tasks only affect splits that already exist, so the copy ingested
    // below is not at risk.
    const moved = group.flatMap(({ row }) =>
      row.indexedGeneration !== null &&
      row.indexedGeneration.startsWith(`${generation}_`)
        ? [{ id: row.id, oldIndexId: row.indexedGeneration }]
        : [],
    );
    let staleError: CorpusIndexError | null = null;
    for (const entry of moved) {
      // oxlint-disable-next-line no-await-in-loop -- sequential deletes that early-break on the first error
      const removed = await removeLegislationFromCorpusIndex(
        entry.id,
        scopedDb,
        entry.oldIndexId,
      );
      if (removed.isErr()) {
        staleError = removed.error;
        break;
      }
    }
    if (staleError) {
      firstError ??= staleError;
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- per-jurisdiction indexes are ensured/ingested sequentially to avoid overwhelming the search backend
    const ensured = await ensureIndex(indexId);
    const ingest = ensured.isErr()
      ? ensured
      : // oxlint-disable-next-line no-await-in-loop -- sequential per-group ingest paces NDJSON pushes to the search backend
        await getCorpusIndexClient().ingestBatch(
          indexId,
          group.map(({ doc }) => JSON.stringify(doc)).join("\n"),
        );

    if (ingest.isErr()) {
      firstError ??= ingest.error;
      // oxlint-disable-next-line no-await-in-loop -- sequential per-group audit write preserves job ordering
      await recordJobs(
        scopedDb,
        group.map(({ row }) => ({
          documentId: row.id,
          contentHash: row.contentHash,
          operation: "index" as const,
          status: "failed" as const,
          errorMessage: ingest.error.message.slice(0, 2048),
        })),
        indexId,
      );
      continue;
    }

    const casMissed: SafeId<"legislationDocument">[] = [];
    // oxlint-disable-next-line no-await-in-loop -- one CAS transaction per group; sequential to keep index writes and audit rows consistent
    await scopedDb(async (tx) => {
      // audit: skip — search index maintenance; rebuilds derived state
      for (const { row } of group) {
        // Compare-and-set on the selected row state: a concurrent
        // re-ingest clears indexedHash (possibly leaving it null-to-null
        // when the row was already pending) and bumps updatedAt, and an
        // unconditional write would mask that refresh so the stale index
        // document would never be retried.
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential CAS updates within the transaction; ordering preserved
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
        if (marked.length === 0) {
          casMissed.push(row.id);
        }
      }
      const markedRows = group.filter(({ row }) => !casMissed.includes(row.id));
      if (markedRows.length > 0) {
        await tx.insert(legislationIndexJobs).values(
          markedRows.map(({ row }) => ({
            documentId: row.id,
            generation: indexId,
            operation: "index" as const,
            status: "succeeded" as const,
            contentHash: row.contentHash,
          })),
        );
      }
    });
    // A missed CAS means a refresh outpaced this batch after the ingest
    // appended its document: the row carries no generation pointer to it,
    // so delete the unrecorded copy now; the refreshed row is re-indexed
    // by a later cycle.
    for (const missedId of casMissed) {
      // oxlint-disable-next-line no-await-in-loop -- sequential cleanup deletes of the unrecorded copies
      const removed = await removeLegislationFromCorpusIndex(
        missedId,
        scopedDb,
        indexId,
      );
      if (removed.isErr()) {
        firstError ??= removed.error;
      }
    }
    indexed += group.length - casMissed.length;
  }

  if (firstError) {
    // eslint-disable-next-line no-throw-literal -- CorpusIndexError (TaggedError); rethrow to abort the batch for retry
    throw firstError;
  }

  return indexed;
};

type JobInput = {
  documentId: SafeId<"legislationDocument">;
  contentHash: string | null;
  operation: "index" | "delete" | "redact" | "rebuild";
  status: "succeeded" | "failed";
  errorMessage?: string;
};

const recordJobs = async (
  scopedDb: ScopedDb,
  jobs: readonly JobInput[],
  generation: string,
): Promise<void> => {
  if (jobs.length === 0) {
    return;
  }
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — append-only index-job rows ARE the indexing audit trail
    return tx.insert(legislationIndexJobs).values(
      jobs.map((job) => ({
        documentId: job.documentId,
        generation,
        operation: job.operation,
        status: job.status,
        contentHash: job.contentHash,
        errorMessage: job.errorMessage ?? null,
      })),
    );
  });
};

export const removeLegislationFromCorpusIndex = async (
  documentId: SafeId<"legislationDocument">,
  scopedDb: ScopedDb,
  indexId: string,
  operation: "delete" | "redact" = "delete",
): Promise<Result<void, CorpusIndexError>> => {
  const result = await getCorpusIndexClient().deleteByQuery(
    indexId,
    `document_id:"${documentId}"`,
  );
  await recordJobs(
    scopedDb,
    [
      {
        documentId,
        contentHash: null,
        operation,
        status: result.isErr() ? "failed" : "succeeded",
        ...(result.isErr()
          ? { errorMessage: result.error.message.slice(0, 2048) }
          : {}),
      },
    ],
    indexId,
  );
  return result;
};
