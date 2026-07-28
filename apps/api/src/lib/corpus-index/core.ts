import { Result } from "better-result";
import { Buffer } from "node:buffer";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-family";
import {
  getCorpusIndexClient,
  type CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { LIMITS } from "@/api/lib/limits";

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
/** Run the stale scan at least once per this many batches under a full
 *  missing backlog (see the duty-cycle note in `backfill`). */
const STALE_SCAN_DUTY_CYCLE = 20;

/**
 * Delete-task query selecting every search document a row projects to. Keyed
 * on the stable Postgres id, which every one of the row's documents carries,
 * so it is exactly as correct for a passage-split row as for a whole one — and
 * it needs no record of how many documents the previous version emitted.
 */
export const corpusDocumentDeleteQuery = (entityId: string): string =>
  `document_id:"${entityId}"`;

/** One row and every search document it projects to. */
type BuiltRow<TRow> = { row: TRow; docs: Record<string, unknown>[] };

/** One ingest request: the rows it covers and the NDJSON body carrying them. */
export type IngestRequest<TRow> = {
  entries: BuiltRow<TRow>[];
  ndjson: string;
};

/**
 * Split an index group into byte-bounded ingest requests.
 *
 * A batch is sized in rows, but a passage family turns one row into as many
 * documents as the document has passages, so the serialized body is no longer
 * bounded by the row count: a batch of long judgments can be two orders of
 * magnitude larger than the same batch of short ones. The whole body is held
 * in memory and sent as one request, so the bound has to be bytes.
 *
 * Splits only at row boundaries. Ingest appends per document with no
 * cross-document transaction, so splitting is safe for the engine — but the
 * caller commits a row's `indexedHash` after its documents land, and a row cut
 * across two requests could be marked indexed while half its passages are
 * missing. A single row that exceeds the budget on its own therefore still
 * goes in one request: sending it whole is the only shape that keeps that mark
 * honest, and it is bounded by the size of one court decision.
 */
export const splitIngestRequests = <TRow>(
  group: readonly BuiltRow<TRow>[],
  maxBytes: number,
): IngestRequest<TRow>[] => {
  const requests: IngestRequest<TRow>[] = [];
  let entries: BuiltRow<TRow>[] = [];
  let lines: string[] = [];
  let bytes = 0;

  for (const entry of group) {
    const rowLines = entry.docs.map((doc) => JSON.stringify(doc));
    // Measured in UTF-8 bytes, not code units: legal text is mostly non-ASCII
    // outside English, where `.length` under-counts the wire size by up to 3x.
    const rowBytes = rowLines.reduce(
      (total, line) => total + Buffer.byteLength(line, "utf-8") + 1,
      0,
    );
    if (entries.length > 0 && bytes + rowBytes > maxBytes) {
      requests.push({ entries, ndjson: lines.join("\n") });
      entries = [];
      lines = [];
      bytes = 0;
    }
    entries.push(entry);
    for (const line of rowLines) {
      lines.push(line);
    }
    bytes += rowBytes;
  }

  if (entries.length > 0) {
    requests.push({ entries, ndjson: lines.join("\n") });
  }
  return requests;
};

/**
 * The row fields the shared core reads directly. Each family's own row type
 * extends this with its document-shaped columns, which only its
 * {@link CorpusIndexAdapter.buildDoc} touches.
 */
export type CorpusIndexRow<TBrand extends SafeIdType> = {
  id: SafeId<TBrand>;
  country: string;
  textS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
  indexedHash: string | null;
  indexedGeneration: string | null;
  updatedAt: Date;
};

/**
 * Canonical payload one row contributes to the index. `ast` is loaded only by
 * passage-granularity families (see {@link CorpusIndexGranularity}) and is
 * `null` everywhere else, so a family that indexes whole documents never pays
 * for a second object read.
 */
export type CorpusDocumentPayload = {
  text: string;
  ast: unknown;
};

/**
 * How many search documents one row projects to.
 *
 * - `document`: one, over the row's whole text. The original layout.
 * - `passage`: one per passage of the row's AST, so BM25 scores a paragraph
 *   rather than a whole judgment and every hit carries a deep-link anchor.
 *
 * The families deliberately differ here: case law is long-form argument where
 * the relevant holding is a paragraph, while a legislation row is already a
 * single provision or article and gains nothing from being cut further.
 */
export const CORPUS_INDEX_GRANULARITIES = ["document", "passage"] as const;
export type CorpusIndexGranularity =
  (typeof CORPUS_INDEX_GRANULARITIES)[number];

/**
 * Granularity-dependent half of the adapter. A union rather than an optional
 * hook: a passage family cannot compile without the AST read it needs, and a
 * document family cannot accidentally declare one it never uses.
 */
type CorpusIndexPayloadSurface =
  | { granularity: "document" }
  | {
      granularity: "passage";
      /** Read the canonical AST object for a row's `astS3Key`. */
      readCorpusAst: (key: string) => Promise<unknown>;
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
> = CorpusIndexPayloadSurface & {
  /** Selects the index field mapping / config version for this family. */
  family: CorpusFamily;
  /** Telemetry step label for isolated read failures. */
  captureStep: string;
  /**
   * Build the row's corpus index search documents, omitting empty optional
   * fields. Returns one document at `document` granularity and one per passage
   * at `passage` granularity; either way the row stays a single unit for the
   * commit below, so it carries one `indexedHash`/`indexedGeneration` mark and
   * one audit row no matter how many documents it emitted.
   */
  buildDocs: (
    row: TRow,
    payload: CorpusDocumentPayload,
  ) => Record<string, unknown>[];
  /**
   * Read the canonical corpus text object for a row's `textS3Key`. Supplied
   * by the family adapter (not imported directly) so the shared core stays
   * free of a hard dependency on any one family's object-storage module.
   */
  readCorpusText: (key: string) => Promise<string>;
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
  /**
   * One entry per row, each holding every search document that row projects
   * to. Keeping the row as the unit (rather than flattening to documents) is
   * what lets a passage-split row still take exactly one CAS mark.
   */
  built: { row: TRow; docs: Record<string, unknown>[] }[];
  readFailures: {
    indexId: string;
    job: CorpusJobInput<TBrand>;
    cause: unknown;
  }[];
};

export type LoadDocsForBatchOptions<TBrand extends SafeIdType, TRow> = {
  generation: string;
  fetchFulltext: FetchFulltext<TBrand>;
  /** Override the per-row canonical payload load (test seam). */
  readPayload?: (row: TRow) => Promise<CorpusDocumentPayload>;
  /**
   * Concurrent canonical-object reads per chunk. The daemon default keeps
   * S3 pressure low next to live traffic; a dedicated bulk build may raise
   * it, since the build task is the only reader of its corpus prefix.
   */
  readConcurrency?: number;
};

/**
 * Failed index-job audit rows for the rows an ingest attempt did not land.
 * The brand is inferred from the rows' own ids, so callers never spell it.
 */
const failedIndexJobs = <TBrand extends SafeIdType>(
  entries: readonly BuiltRow<CorpusIndexRow<TBrand>>[],
  error: CorpusIndexError,
): CorpusJobInput<TBrand>[] =>
  entries.map(({ row }) => ({
    entityId: row.id,
    contentHash: row.contentHash,
    operation: "index",
    status: "failed",
    errorMessage: error.message.slice(0, 2048),
  }));

/**
 * `Promise.all` for two operations whose side effects must be finished before
 * the caller moves on. It rejects as soon as one input does, leaving the other
 * running unobserved; this waits for both, then surfaces the first failure in
 * argument order. Use it wherever an abandoned in-flight request would escape a
 * concurrency bound rather than merely be wasted.
 */
export const settleBoth = async <TFirst, TSecond>(
  first: Promise<TFirst>,
  second: Promise<TSecond>,
): Promise<[TFirst, TSecond]> => {
  const [firstOutcome, secondOutcome] = await Promise.allSettled([
    first,
    second,
  ]);
  // Rethrow the original rejection, tagged error and all: the caller's
  // isolation path reads its message into the failed index job, and wrapping
  // it here would bury the cause the operator needs.
  if (firstOutcome.status === "rejected") {
    throw firstOutcome.reason;
  }
  if (secondOutcome.status === "rejected") {
    throw secondOutcome.reason;
  }
  return [firstOutcome.value, secondOutcome.value];
};

const loadText = async <TBrand extends SafeIdType>(
  row: CorpusIndexRow<TBrand>,
  fetchFulltext: FetchFulltext<TBrand>,
  readCorpusText: (key: string) => Promise<string>,
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
      readPayload,
      readConcurrency = INDEX_CONCURRENCY,
    }: LoadDocsForBatchOptions<TBrand, TRow>,
  ): Promise<LoadedBatch<TBrand, TRow>> => {
    const loadRowPayload =
      readPayload ??
      (async (row: TRow): Promise<CorpusDocumentPayload> => {
        // Passage families need the block structure the AST carries; document
        // families never touch it, so the second object read is skipped
        // entirely rather than issued and discarded. The two reads run
        // together, but both must settle before either failure surfaces: a
        // fast rejection that abandoned its sibling would let this row leave
        // the slice while its other request still holds an S3 connection, so
        // the next slice would start on top of it and the concurrency bound
        // this loop exists to enforce would drift upward. Waiting is bounded
        // because every corpus read carries the corpus IO ceiling.
        const [text, ast] = await settleBoth(
          loadText(row, fetchFulltext, adapter.readCorpusText),
          adapter.granularity === "passage" && row.astS3Key !== null
            ? adapter.readCorpusAst(row.astS3Key)
            : Promise.resolve(null),
        );
        return { text, ast };
      });
    const built: LoadedBatch<TBrand, TRow>["built"] = [];
    const readFailures: LoadedBatch<TBrand, TRow>["readFailures"] = [];
    for (let i = 0; i < rows.length; i += readConcurrency) {
      const slice = rows.slice(i, i + readConcurrency);
      // oxlint-disable-next-line no-await-in-loop -- bounded concurrency: drain one INDEX_CONCURRENCY chunk before loading the next so S3 reads stay capped
      const loaded = await Promise.all(
        slice.map(async (row) => {
          try {
            return {
              ok: true as const,
              row,
              docs: adapter.buildDocs(row, await loadRowPayload(row)),
            };
          } catch (error) {
            return { ok: false as const, row, error };
          }
        }),
      );
      for (const entry of loaded) {
        if (entry.ok) {
          built.push({ row: entry.row, docs: entry.docs });
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
    return { built, readFailures };
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
   *
   * The delete is scoped by `document_id`, not by the id of an individual
   * search document, so it removes every search document the row projects to:
   * one at `document` granularity, all N passages at `passage` granularity.
   * That is the only mechanism the client exposes that can do this — the
   * engine appends on ingest and has no primary key to replace by, so a
   * per-document-id delete would need the indexer to know how many passages
   * the *previous* version emitted, which it does not (the previous version's
   * AST is gone once the row's canonical keys move). Scoping the query to the
   * stable Postgres id keeps erasure and re-index correct without that
   * bookkeeping.
   */
  const remove = async (
    entityId: SafeId<TBrand>,
    scopedDb: ScopedDb,
    indexId: string,
    operation: "delete" | "redact" = "delete",
  ): Promise<Result<void, CorpusIndexError>> => {
    const result = await getCorpusIndexClient().deleteByQuery(
      indexId,
      corpusDocumentDeleteQuery(entityId),
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
  let staleSkips = 0;

  const backfill = async (
    scopedDb: ScopedDb,
    batchSize: number,
    generation: string,
    options: { readConcurrency?: number } = {},
  ): Promise<number> => {
    const staleReserved = Math.max(1, Math.floor(batchSize / 4));
    const missingLimit = Math.max(1, batchSize - staleReserved);

    const missing = await adapter.selectMissing(scopedDb, {
      generation,
      limit: missingLimit,
    });

    // The stale scan is duty-cycled while the missing backlog fills its
    // quota. Its predicate (hash mismatch within the current generation)
    // has no covering index, so against a generation with a large missing
    // backlog — a fresh generation build being the extreme — it is a long
    // scan that often returns nothing, paid on every batch. Stale rows
    // are re-indexes of content the index already serves in some version,
    // so they can wait — but not forever: ingestion can keep the missing
    // backlog full indefinitely, so every STALE_SCAN_DUTY_CYCLEth batch
    // still runs the scan with its reserve, bounding staleness instead of
    // trading it away.
    const staleLimit =
      missing.length >= missingLimit && staleSkips < STALE_SCAN_DUTY_CYCLE - 1
        ? 0
        : batchSize - missing.length;
    staleSkips = staleLimit === 0 ? staleSkips + 1 : 0;
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
    const fetchFulltext: FetchFulltext<TBrand> = async (id) =>
      await adapter.fetchFulltext(scopedDb, id);
    const { built, readFailures } = await loadDocsForBatch(rows, {
      generation,
      fetchFulltext,
      ...(options.readConcurrency === undefined
        ? {}
        : { readConcurrency: options.readConcurrency }),
    });
    await recordReadFailures(scopedDb, readFailures, generation);

    // Route each row's documents to its jurisdiction's index
    // (<family>_v1_<country>), grouping so each index gets one NDJSON ingest.
    // A group that fails to ensure/ingest is recorded and retried next cycle;
    // other groups still commit. The group's unit stays the row, so counting,
    // marking, and auditing below are unaffected by how many documents a row
    // projects to.
    const groups = new Map<string, typeof built>();
    for (const entry of built) {
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
      // Failed index-job rows for this group, written in the `finally` below.
      // An ingest failure can now surface at two levels (the index could not
      // be ensured, or one request of several was rejected), so they are
      // collected rather than written at each site — but they must never
      // outlive the group that produced them: buffering across groups meant a
      // later group throwing (a DB error in a delete, CAS, or audit insert)
      // skipped the write entirely and the earlier failure left no audit row
      // at all. One group writes to exactly one index, so this needs no
      // keying.
      const groupFailures: CorpusJobInput<TBrand>[] = [];
      try {
        // Ingest appends; it never replaces. Before re-ingesting, delete the
        // previously indexed copies from wherever they live (the same index for
        // a content refresh, another jurisdiction index for a corrected
        // country), or stale copies keep matching old text. `remove` deletes by
        // `document_id`, so a row whose previous version split into a different
        // number of passages leaves nothing behind. Same generation only:
        // generation rebuilds replace whole indexes. Engine delete tasks only
        // affect splits that already exist, so the copies ingested below are not
        // at risk.
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
        if (ensured.isErr()) {
          firstError ??= ensured.error;
          groupFailures.push(...failedIndexJobs(group, ensured.error));
          continue;
        }

        // One group can exceed a single request's byte budget once rows project
        // to many documents, so it goes out as a sequence of requests. Each is
        // committed on its own: a later request failing must not un-commit the
        // rows an earlier one already landed, because those documents are in the
        // index and re-ingesting them next cycle would append a second copy that
        // nothing points at.
        for (const { entries, ndjson } of splitIngestRequests(
          group,
          LIMITS.corpusIndexIngestMaxBytes,
        )) {
          // oxlint-disable-next-line no-await-in-loop -- sequential ingest paces NDJSON pushes to the search backend
          const ingest = await getCorpusIndexClient().ingestBatch(
            indexId,
            ndjson,
          );

          if (ingest.isErr()) {
            firstError ??= ingest.error;
            // Only the rows actually attempted are recorded failed; the rest of
            // the group is left for the next cycle rather than audited as a
            // failure that never happened.
            groupFailures.push(...failedIndexJobs(entries, ingest.error));
            break;
          }

          const casMissed = new Set<SafeId<TBrand>>();
          // oxlint-disable-next-line no-await-in-loop -- one CAS transaction per ingest request; sequential to keep index writes and audit rows consistent
          await scopedDb(async (tx) => {
            // audit: skip — search index maintenance; rebuilds derived state
            for (const { row } of entries) {
              // Compare-and-set on the selected row state: a concurrent
              // re-ingest clears indexedHash (possibly leaving it null-to-null
              // when the row was already pending) and bumps updatedAt, and an
              // unconditional write would mask that refresh so the stale index
              // document would never be retried.
              // oxlint-disable-next-line no-await-in-loop -- sequential CAS updates within the transaction; ordering preserved
              const marked = await adapter.markIndexed(tx, {
                row,
                indexId,
                now,
              });
              if (!marked) {
                casMissed.add(row.id);
              }
            }
            const markedRows = entries
              .filter(({ row }) => !casMissed.has(row.id))
              .map(({ row }) => row);
            if (markedRows.length > 0) {
              await adapter.insertSucceededJobs(tx, {
                rows: markedRows,
                indexId,
              });
            }
          });
          // A missed CAS means a refresh outpaced this batch after the ingest
          // appended its documents: the row carries no generation pointer to
          // them, so delete the unrecorded copies now; the refreshed row is
          // re-indexed by a later cycle.
          for (const missedId of casMissed) {
            // oxlint-disable-next-line no-await-in-loop -- sequential cleanup deletes of the unrecorded copies; matches this file's established sequential-vs-search-backend design (see ensureIndex/ingestBatch above)
            const removed = await remove(missedId, scopedDb, indexId);
            if (removed.isErr()) {
              firstError ??= removed.error;
            }
          }
          indexed += entries.length - casMissed.size;
        }
      } finally {
        // Always lands, including when the code above threw. The audit
        // trail is how an operator sees which rows the indexer could not
        // place; a row that is neither indexed nor recorded failed is
        // invisible.
        if (groupFailures.length > 0) {
          // oxlint-disable-next-line no-await-in-loop -- sequential per-group audit write preserves job ordering
          await adapter.recordJobs(scopedDb, groupFailures, indexId);
        }
      }
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
