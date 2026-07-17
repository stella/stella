import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-family";
import {
  getCorpusIndexClient,
  type CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

/**
 * Shared corpus-index search-projection core for the corpus document families
 * (case_law, legislation). A backfill loop indexes corpus-backed rows whose
 * content changed or that are missing from the active generation; the license
 * gate lives in each family's SQL filter so non-redistributable sources never
 * enter the scan. Every mutation is recorded in the family's index-jobs audit
 * trail. Each family plugs in a thin {@link CorpusIndexAdapter} that supplies
 * the domain surface (tables, batch queries, per-row document shape); this
 * module owns the orchestration, bounded-concurrency S3 loads, per-group commit
 * with compare-and-set, and the read-failure isolation that are identical
 * across families.
 */

const INDEX_CONCURRENCY = 4;

/**
 * The row fields the shared core reads directly. Each family's own row type
 * extends this with its document-shaped columns, which only its
 * {@link CorpusIndexAdapter.buildDoc} touches.
 */
export type CorpusIndexRow<TBrand extends SafeIdType> = {
  id: SafeId<TBrand>;
  country: string;
  textS3Key: string | null;
  contentHash: string | null;
  indexedHash: string | null;
  indexedGeneration: string | null;
  updatedAt: Date;
};

/** One audit-trail entry for a corpus index-jobs row. */
export type CorpusJobInput<TBrand extends SafeIdType> = {
  entityId: SafeId<TBrand>;
  contentHash: string | null;
  operation: "index" | "delete" | "redact" | "rebuild";
  status: "succeeded" | "failed";
  errorMessage?: string;
};

/** Lazy Postgres fulltext fallback for rows without a canonical S3 object. */
export type FetchFulltext<TBrand extends SafeIdType> = (
  id: SafeId<TBrand>,
) => Promise<string | null>;

type SelectBatchArgs = { generation: string; limit: number };

/**
 * Family-specific surface consumed by the shared core. Everything that touches
 * a family's Drizzle tables or its per-document shape lives here; the core
 * never references a concrete table. Implementations are the thin adapters in
 * each `handlers/<family>/corpus-index.ts`.
 */
export type CorpusIndexAdapter<
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
> = {
  /** Selects the index field mapping / config version for this family. */
  family: CorpusFamily;
  /** Telemetry step label for isolated read failures. */
  captureStep: string;
  /** Build the corpus index search document, omitting empty optional fields. */
  buildDoc: (row: TRow, text: string) => Record<string, unknown>;
  /**
   * Rows not yet in this generation (missing). Ordered oldest-first, bounded by
   * `limit`; the license gate is applied in the query.
   */
  selectMissing: (scopedDb: ScopedDb, args: SelectBatchArgs) => Promise<TRow[]>;
  /**
   * Rows in this generation whose content changed since last push (stale).
   * Ordered oldest-first, bounded by `limit`; license gate applied in-query.
   */
  selectStale: (scopedDb: ScopedDb, args: SelectBatchArgs) => Promise<TRow[]>;
  /** Lazy per-row Postgres fulltext fallback (rows without a corpus object). */
  fetchFulltext: (
    scopedDb: ScopedDb,
    id: SafeId<TBrand>,
  ) => Promise<string | null>;
  /**
   * Compare-and-set the selected row state to indexed, within the caller's
   * transaction. Returns whether the row was marked (false = a concurrent
   * refresh moved it on, so the caller treats it as a CAS miss).
   */
  markIndexed: (
    tx: Transaction,
    args: { row: TRow; indexId: string; now: Date },
  ) => Promise<boolean>;
  /** Insert succeeded index-job audit rows within the caller's transaction. */
  insertSucceededJobs: (
    tx: Transaction,
    args: { rows: readonly TRow[]; indexId: string },
  ) => Promise<void>;
  /** Append index-job audit rows (failed reads/ingests, deletes) via scopedDb. */
  recordJobs: (
    scopedDb: ScopedDb,
    jobs: readonly CorpusJobInput<TBrand>[],
    generation: string,
  ) => Promise<void>;
};

export type LoadedBatch<TBrand extends SafeIdType, TRow> = {
  docs: { row: TRow; doc: Record<string, unknown> }[];
  readFailures: {
    indexId: string;
    job: CorpusJobInput<TBrand>;
    cause: unknown;
  }[];
};

export type LoadDocsForBatchOptions<TBrand extends SafeIdType, TRow> = {
  generation: string;
  fetchFulltext: FetchFulltext<TBrand>;
  /** Override the per-row text load (test seam). */
  readText?: (row: TRow) => Promise<string>;
};

const loadText = async <
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
>(
  row: TRow,
  fetchFulltext: FetchFulltext<TBrand>,
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

/**
 * Bound corpus indexer for one document family. Instantiate once per family at
 * module scope so the per-process `ensuredIndexes` cache is shared across
 * batches. Exposes the family's route-facing operations, which each handler
 * re-exports under its established names.
 */
export const createCorpusIndexer = <
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
>(
  adapter: CorpusIndexAdapter<TBrand, TRow>,
) => {
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
      const created = await client.createIndex(
        corpusIndexConfig(adapter.family, indexId),
      );
      if (created.isErr()) {
        return Result.err(created.error);
      }
    }
    ensuredIndexes.add(indexId);
    return Result.ok(undefined);
  };

  /**
   * Build each row's index document from its canonical text, isolating per-row
   * read failures. A bounded corpus read that times out or errors fails only
   * its own document: that row is collected as a failed index job and dropped
   * from the batch (never marked indexed, so a later cycle retries it), while
   * its batch-mates still commit. Reads run in bounded-concurrency chunks so S3
   * pressure stays capped. `readText` is injectable so the isolation can be
   * exercised without a live object store.
   */
  const loadDocsForBatch = async (
    rows: readonly TRow[],
    {
      generation,
      fetchFulltext,
      readText,
    }: LoadDocsForBatchOptions<TBrand, TRow>,
  ): Promise<LoadedBatch<TBrand, TRow>> => {
    const loadRowText =
      readText ?? (async (row: TRow) => await loadText(row, fetchFulltext));
    const docs: LoadedBatch<TBrand, TRow>["docs"] = [];
    const readFailures: LoadedBatch<TBrand, TRow>["readFailures"] = [];
    for (let i = 0; i < rows.length; i += INDEX_CONCURRENCY) {
      const chunk = rows.slice(i, i + INDEX_CONCURRENCY);
      // oxlint-disable-next-line no-await-in-loop -- bounded concurrency: drain one INDEX_CONCURRENCY chunk before loading the next so S3 reads stay capped
      const built = await Promise.all(
        chunk.map(async (row) => {
          try {
            return {
              ok: true as const,
              row,
              doc: adapter.buildDoc(row, await loadRowText(row)),
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
            entityId: entry.row.id,
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
   * document text — and writes a failed index job (the established audit
   * convention) under each affected jurisdiction index. The rows stay
   * unindexed, so a later cycle retries them while the batch's healthy
   * documents proceed.
   */
  const recordReadFailures = async (
    scopedDb: ScopedDb,
    readFailures: LoadedBatch<TBrand, TRow>["readFailures"],
    generation: string,
  ): Promise<void> => {
    const firstFailure = readFailures.at(0);
    if (!firstFailure) {
      return;
    }
    captureError(firstFailure.cause, {
      step: adapter.captureStep,
      generation,
      failed: String(readFailures.length),
    });
    const failuresByIndex = new Map<string, CorpusJobInput<TBrand>[]>();
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
      await adapter.recordJobs(scopedDb, jobs, indexId);
    }
  };

  /**
   * Remove a document from a corpus index generation (GDPR/takedown). Uses a
   * delete-task (corpus index's async delete path) and records the operation.
   */
  const remove = async (
    entityId: SafeId<TBrand>,
    scopedDb: ScopedDb,
    indexId: string,
    operation: "delete" | "redact" = "delete",
  ): Promise<Result<void, CorpusIndexError>> => {
    const result = await getCorpusIndexClient().deleteByQuery(
      indexId,
      `document_id:"${entityId}"`,
    );
    await adapter.recordJobs(
      scopedDb,
      [
        {
          entityId,
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

  /**
   * Index a batch of corpus-backed rows into the given generation. Two-query
   * missing/stale split mirrors backfillSearchIndex: `missing` = not yet in
   * this generation; `stale` = content changed since last push. Reserves a
   * quarter of the batch for stale so re-indexes are not starved by a
   * missing-doc backlog. Returns the number indexed.
   */
  const backfill = async (
    scopedDb: ScopedDb,
    batchSize: number,
    generation: string,
  ): Promise<number> => {
    const staleReserved = Math.max(1, Math.floor(batchSize / 4));
    const missingLimit = Math.max(1, batchSize - staleReserved);

    const missing = await adapter.selectMissing(scopedDb, {
      generation,
      limit: missingLimit,
    });

    const staleLimit = batchSize - missing.length;
    const stale =
      staleLimit <= 0
        ? []
        : await adapter.selectStale(scopedDb, {
            generation,
            limit: staleLimit,
          });

    const rows: TRow[] = [...missing, ...stale];
    if (rows.length === 0) {
      return 0;
    }

    // Load text (S3) with bounded concurrency, then ingest one NDJSON batch.
    // A per-document read failure fails only that document; record it and let
    // the rest still commit.
    const fetchFulltext: FetchFulltext<TBrand> = (id) =>
      adapter.fetchFulltext(scopedDb, id);
    const { docs, readFailures } = await loadDocsForBatch(rows, {
      generation,
      fetchFulltext,
    });
    await recordReadFailures(scopedDb, readFailures, generation);

    // Route each doc to its jurisdiction's index (<family>_v1_<country>),
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
        const removed = await remove(entry.id, scopedDb, entry.oldIndexId);
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
        await adapter.recordJobs(
          scopedDb,
          group.map(({ row }) => ({
            entityId: row.id,
            contentHash: row.contentHash,
            operation: "index" as const,
            status: "failed" as const,
            errorMessage: ingest.error.message.slice(0, 2048),
          })),
          indexId,
        );
        continue;
      }

      const casMissed = new Set<SafeId<TBrand>>();
      // oxlint-disable-next-line no-await-in-loop -- one CAS transaction per group; sequential to keep index writes and audit rows consistent
      await scopedDb(async (tx) => {
        // audit: skip — search index maintenance; rebuilds derived state
        for (const { row } of group) {
          // Compare-and-set on the selected row state: a concurrent
          // re-ingest clears indexedHash (possibly leaving it null-to-null
          // when the row was already pending) and bumps updatedAt, and an
          // unconditional write would mask that refresh so the stale index
          // document would never be retried.
          // oxlint-disable-next-line no-await-in-loop -- sequential CAS updates within the transaction; ordering preserved
          const marked = await adapter.markIndexed(tx, { row, indexId, now });
          if (!marked) {
            casMissed.add(row.id);
          }
        }
        const markedRows = group
          .filter(({ row }) => !casMissed.has(row.id))
          .map(({ row }) => row);
        if (markedRows.length > 0) {
          await adapter.insertSucceededJobs(tx, { rows: markedRows, indexId });
        }
      });
      // A missed CAS means a refresh outpaced this batch after the ingest
      // appended its document: the row carries no generation pointer to it,
      // so delete the unrecorded copy now; the refreshed row is re-indexed
      // by a later cycle.
      for (const missedId of casMissed) {
        // oxlint-disable-next-line no-await-in-loop -- sequential cleanup deletes of the unrecorded copies; matches this file's established sequential-vs-search-backend design (see ensureIndex/ingestBatch above)
        const removed = await remove(missedId, scopedDb, indexId);
        if (removed.isErr()) {
          firstError ??= removed.error;
        }
      }
      indexed += group.length - casMissed.size;
    }

    // Surface a failure so the daemon retries the un-indexed groups.
    if (firstError) {
      // eslint-disable-next-line no-throw-literal -- CorpusIndexError (TaggedError); rethrow to abort the batch for retry
      throw firstError;
    }

    return indexed;
  };

  return { loadDocsForBatch, backfill, remove };
};
