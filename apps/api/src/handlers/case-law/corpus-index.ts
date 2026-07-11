import { Result } from "better-result";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getCorpusIndexClient,
  type CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { caseLawIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

/**
 * corpus index search-projection maintenance. Mirrors search-index.ts (the
 * pg-fts projection): a backfill loop indexes corpus-backed decisions
 * whose content changed or that are missing from the active generation.
 * The license gate lives in the SQL filter so non-redistributable
 * sources never enter the scan (and cannot stall it). Every mutation is
 * recorded in the case_law_index_jobs audit trail.
 */

const INDEX_CONCURRENCY = 4;

type IndexableRow = {
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  caseNumber: string;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  decisionDate: string | null;
  decisionType: string | null;
  citationAuthority: number;
  citationCount: number;
  textS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
  indexedHash: string | null;
  indexedGeneration: string | null;
  updatedAt: Date;
};

// Deliberately excludes `fulltext`: it is only the fallback for rows without
// a canonical S3 object, and selecting it for every row would drag megabytes
// of text through one batch transaction. Rows that need it fetch it lazily,
// one small bounded read per document (see loadText / fetchFulltext).
const SELECT_COLUMNS = {
  id: caseLawDecisions.id,
  sourceId: caseLawDecisions.sourceId,
  caseNumber: caseLawDecisions.caseNumber,
  ecli: caseLawDecisions.ecli,
  court: caseLawDecisions.court,
  country: caseLawDecisions.country,
  language: caseLawDecisions.language,
  decisionDate: caseLawDecisions.decisionDate,
  decisionType: caseLawDecisions.decisionType,
  citationAuthority: caseLawDecisions.citationAuthority,
  citationCount: caseLawDecisions.citationCount,
  textS3Key: caseLawDecisions.textS3Key,
  astS3Key: caseLawDecisions.astS3Key,
  contentHash: caseLawDecisions.contentHash,
  indexedHash: caseLawDecisions.indexedHash,
  indexedGeneration: caseLawDecisions.indexedGeneration,
  updatedAt: caseLawDecisions.updatedAt,
};

// A row is indexable once its canonical payload is in object storage.
const hasContent = sql`${caseLawDecisions.contentHash} IS NOT NULL`;

// Per-jurisdiction indexes are created on first write. Cache the ids we
// have confirmed this process so we don't probe corpus index every batch.
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
    const created = await client.createIndex(caseLawIndexConfig(indexId));
    if (created.isErr()) {
      return Result.err(created.error);
    }
  }
  ensuredIndexes.add(indexId);
  return Result.ok(undefined);
};

/** Build the corpus index search document, omitting empty optional fields. */
const buildDoc = (row: IndexableRow, text: string): Record<string, unknown> => {
  // eslint-disable-next-line no-untyped-updates/no-untyped-updates -- corpus index ingest document, not a DB update
  const doc: Record<string, unknown> = {
    document_id: row.id,
    jurisdiction: row.country,
    source: row.sourceId,
    court: row.court,
    language: row.language,
    title: `${row.caseNumber} — ${row.court}`,
    text,
    citation_authority: row.citationAuthority,
    citation_count: row.citationCount,
  };
  if (row.decisionType !== null) {
    doc["document_type"] = row.decisionType;
  }
  if (row.decisionDate !== null) {
    doc["decision_date"] = row.decisionDate;
    doc["year"] = Number(row.decisionDate.slice(0, 4));
  }
  if (row.ecli !== null) {
    doc["ecli"] = row.ecli;
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
type FetchFulltext = (id: SafeId<"caseLawDecision">) => Promise<string | null>;

const loadText = async (
  row: IndexableRow,
  fetchFulltext: FetchFulltext,
): Promise<string> => {
  // No catch-and-fallback here: a read failure propagates so the caller
  // can isolate this document (record it failed, drop it from the batch) and
  // retry it next cycle. Swallowing it and indexing empty text would then
  // record indexedHash = contentHash, permanently pinning a broken entry.
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
 * read failures. A bounded corpus read that times out or errors fails only its
 * own document: that row is collected as a failed index job and dropped from
 * the batch (never marked indexed, so a later cycle retries it), while its
 * batch-mates still commit. Reads run in bounded-concurrency chunks so S3
 * pressure stays capped. `readText` is injectable so the isolation can be
 * exercised without a live object store.
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
          decisionId: entry.row.id,
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
 * Fail loud, continue: record isolated per-document read failures. Captures
 * the underlying (tagged) error with jurisdiction/generation context — never
 * decision text — and writes a failed index job (the established audit
 * convention) under each affected jurisdiction index. The rows stay unindexed,
 * so a later cycle retries them while the batch's healthy documents proceed.
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
    step: "backfillCorpusIndex.loadText",
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

/**
 * Index a batch of corpus-backed decisions into the given generation.
 * Two-query missing/stale split mirrors backfillSearchIndex: `missing`
 * = not yet in this generation; `stale` = content changed since last
 * push. Reserves a quarter of the batch for stale so re-indexes are not
 * starved by a missing-doc backlog. Returns the number indexed.
 */
export const backfillCorpusIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
  generation: string,
): Promise<number> => {
  const staleReserved = Math.max(1, Math.floor(batchSize / 4));
  const missingLimit = Math.max(1, batchSize - staleReserved);

  const missing = await scopedDb((tx) =>
    tx
      .select(SELECT_COLUMNS)
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          hasContent,
          redistributableCaseLawSource,
          or(
            isNull(caseLawDecisions.indexedGeneration),
            sql`${caseLawDecisions.indexedGeneration} <> (${generation} || '_' || lower(${caseLawDecisions.country}))`,
          ),
        ),
      )
      .orderBy(asc(caseLawDecisions.createdAt))
      .limit(missingLimit),
  );

  const staleLimit = batchSize - missing.length;
  const stale =
    staleLimit <= 0
      ? []
      : await scopedDb((tx) =>
          tx
            .select(SELECT_COLUMNS)
            .from(caseLawDecisions)
            .innerJoin(
              caseLawSources,
              eq(caseLawSources.id, caseLawDecisions.sourceId),
            )
            .where(
              and(
                hasContent,
                redistributableCaseLawSource,
                sql`${caseLawDecisions.indexedGeneration} = (${generation} || '_' || lower(${caseLawDecisions.country}))`,
                sql`${caseLawDecisions.indexedHash} IS DISTINCT FROM ${caseLawDecisions.contentHash}`,
              ),
            )
            .orderBy(asc(caseLawDecisions.createdAt))
            .limit(staleLimit),
        );

  const rows: IndexableRow[] = [...missing, ...stale];
  if (rows.length === 0) {
    return 0;
  }

  // Load text (S3) with bounded concurrency, then ingest one NDJSON batch.
  // A per-document read failure fails only that document; record it and let
  // the rest still commit.
  const fetchFulltext: FetchFulltext = async (id) => {
    const fallback = await scopedDb((tx) =>
      tx
        .select({ fulltext: caseLawDecisions.fulltext })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, id))
        .limit(1),
    );
    return fallback.at(0)?.fulltext ?? null;
  };
  const { docs, readFailures } = await loadDocsForBatch(rows, {
    generation,
    fetchFulltext,
  });
  await recordReadFailures(scopedDb, readFailures, generation);

  // Route each doc to its jurisdiction's index (case_law_v1_<country>),
  // grouping so each index gets one NDJSON ingest. A group that fails to
  // ensure/ingest is recorded and retried next cycle; other groups still
  // commit.
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
      const removed = await removeDecisionFromCorpusIndex(
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
          decisionId: row.id,
          contentHash: row.contentHash,
          operation: "index" as const,
          status: "failed" as const,
          errorMessage: ingest.error.message.slice(0, 2048),
        })),
        indexId,
      );
      continue;
    }

    const casMissed: SafeId<"caseLawDecision">[] = [];
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
          .update(caseLawDecisions)
          .set({
            indexedHash: row.contentHash,
            indexedGeneration: indexId,
            indexedAt: now,
          })
          .where(
            and(
              eq(caseLawDecisions.id, row.id),
              sql`${caseLawDecisions.indexedHash} IS NOT DISTINCT FROM ${row.indexedHash}`,
              sql`${caseLawDecisions.updatedAt} IS NOT DISTINCT FROM ${row.updatedAt}`,
            ),
          )
          .returning({ id: caseLawDecisions.id });
        if (marked.length === 0) {
          casMissed.push(row.id);
        }
      }
      const markedRows = group.filter(({ row }) => !casMissed.includes(row.id));
      if (markedRows.length > 0) {
        await tx.insert(caseLawIndexJobs).values(
          markedRows.map(({ row }) => ({
            decisionId: row.id,
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
      const removed = await removeDecisionFromCorpusIndex(
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

  // Surface a failure so the daemon retries the un-indexed groups.
  if (firstError) {
    // eslint-disable-next-line no-throw-literal -- CorpusIndexError (TaggedError); rethrow to abort the batch for retry
    throw firstError;
  }

  return indexed;
};

type JobInput = {
  decisionId: SafeId<"caseLawDecision">;
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
    return tx.insert(caseLawIndexJobs).values(
      jobs.map((job) => ({
        decisionId: job.decisionId,
        generation,
        operation: job.operation,
        status: job.status,
        contentHash: job.contentHash,
        errorMessage: job.errorMessage ?? null,
      })),
    );
  });
};

/**
 * Remove a decision from a corpus index generation (GDPR/takedown). Uses a
 * delete-task (corpus index's async delete path) and records the operation.
 */
export const removeDecisionFromCorpusIndex = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
  indexId: string,
  operation: "delete" | "redact" = "delete",
): Promise<Result<void, CorpusIndexError>> => {
  const result = await getCorpusIndexClient().deleteByQuery(
    indexId,
    `document_id:"${decisionId}"`,
  );
  await recordJobs(
    scopedDb,
    [
      {
        decisionId,
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
