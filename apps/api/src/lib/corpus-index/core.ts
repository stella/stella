import { panic, Result } from "better-result";
import { Buffer } from "node:buffer";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-family";
import { corpusIndexClusterForGeneration } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_COMMIT,
  CorpusIndexError,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import type {
  CorpusIndexClient,
  CorpusIndexCommitMode,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexGeneration,
  corpusIndexId,
} from "@/api/lib/legal-search/index-naming";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

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

export const FENCED_BACKFILL_BATCH_STATUS = {
  ADVANCED: "advanced",
  COMPLETE: "complete",
  RETRY: "retry",
} as const;

export type FencedBackfillBatchResult =
  | {
      indexed: number;
      status: typeof FENCED_BACKFILL_BATCH_STATUS.ADVANCED;
    }
  | {
      indexed: 0;
      status:
        | typeof FENCED_BACKFILL_BATCH_STATUS.COMPLETE
        | typeof FENCED_BACKFILL_BATCH_STATUS.RETRY;
    };

/**
 * What became of every row handed to one backfill call.
 *
 * A batch can settle fewer rows than it selected without anything having
 * failed: a row whose compare-and-set lost to a concurrent refresh is left
 * for a later cycle, and a row whose corpus text could not be read is
 * recorded as a failed job. Both are deferrals, not lost updates, so the
 * indexed count alone cannot tell a caller whether its selection was fully
 * accounted for. Reporting the split makes that readable — and makes the
 * accounting itself checkable, because `indexed + refreshed + unread` is
 * always the number of rows passed in.
 */
export type CorpusBackfillOutcome = {
  indexed: number;
  /**
   * Moved by a concurrent refresh, at the append reservation or at the mark;
   * left in the pending set for a later cycle.
   */
  refreshed: number;
  /** Corpus text could not be read; recorded as a failed job. */
  unread: number;
};

const corpusIndexErrorFromThrown = (error: unknown): CorpusIndexError =>
  error instanceof CorpusIndexError
    ? error
    : new CorpusIndexError({
        message:
          error instanceof Error
            ? error.message
            : "corpus index operation failed",
        cause: error,
      });

/**
 * Ids a delete term can carry verbatim. `SafeId` is a compile-time brand over
 * `string` and asserts nothing about the characters, so the quoted term needs
 * its own guarantee.
 */
const DELETABLE_DOCUMENT_ID = /^[A-Za-z0-9_-]+$/u;

/**
 * Delete-task query selecting every search document a batch of rows projects
 * to. Keyed on the stable Postgres id, which every one of a row's documents
 * carries, so it is exactly as correct for a passage-split row as for a whole
 * one, and it needs no record of how many documents the previous version
 * emitted.
 *
 * Terms are OR-joined rather than written as an engine set query: the joined
 * form parses identically across query-language versions, and a delete query
 * that silently changes meaning removes the wrong documents.
 */
export const corpusDocumentsDeleteQuery = (
  entityIds: readonly string[],
): string =>
  entityIds
    .map((id) =>
      DELETABLE_DOCUMENT_ID.test(id)
        ? `document_id:"${id}"`
        : // Not escaped, rejected: these ids come from `uuid` columns, so one
          // that could alter the query is a defect upstream, not input to
          // sanitize. Escaping would let the defect through silently, and the
          // OR-join means a single crafted term changes what the whole task
          // deletes.
          panic(`corpus delete query received an unusable document id: ${id}`),
    )
    .join(" OR ");

/** Single-row delete query; the batch of one. */
export const corpusDocumentDeleteQuery = (entityId: string): string =>
  corpusDocumentsDeleteQuery([entityId]);

/**
 * Ids per delete task. The engine plans every delete task against every split
 * whose delete opstamp is behind it, so task COUNT (not task size) is what
 * costs: one task per row makes planning O(rows x splits) and the planner
 * stops converging once the backlog outruns it. Batching is therefore the
 * point, and this bound only keeps the query a single task carries from
 * growing without limit.
 */
const DELETE_QUERY_MAX_IDS = 128;

/** Partition ids into per-task groups, each within {@link DELETE_QUERY_MAX_IDS}. */
export const deleteQueryChunks = <T>(entityIds: readonly T[]): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < entityIds.length; index += DELETE_QUERY_MAX_IDS) {
    chunks.push([...entityIds.slice(index, index + DELETE_QUERY_MAX_IDS)]);
  }
  return chunks;
};

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
  /**
   * Exact-precision CAS token for `updated_at` (see `lib/db/timestamp-cas`).
   * Never a `Date`: the millisecond round-trip made every microsecond-
   * precision row unmatchable.
   */
  updatedAtToken: TimestampCasToken;
};

/**
 * Resolve a batched mark statement's RETURNING ids against the rows the
 * statement was built from. Matching through the input rows keeps the branded
 * ids without an assertion, and only ids the batch actually supplied can come
 * back. The production driver returns the rows directly; pglite (tests) wraps
 * them in `{ rows }` — both shapes are accepted.
 */
export const resolveMarkedRowIds = <TBrand extends SafeIdType>(
  marked: unknown,
  rows: readonly CorpusIndexRow<TBrand>[],
): Set<SafeId<TBrand>> => {
  let returned: unknown[] = [];
  if (Array.isArray(marked)) {
    returned = marked;
  } else if (isRecord(marked) && Array.isArray(marked["rows"])) {
    returned = marked["rows"];
  }
  const byId = new Map<string, SafeId<TBrand>>(
    rows.map((row) => [row.id, row.id]),
  );
  const ids = new Set<SafeId<TBrand>>();
  for (const entry of returned) {
    if (isRecord(entry) && typeof entry["id"] === "string") {
      const id = byId.get(entry["id"]);
      if (id !== undefined) {
        ids.add(id);
      }
    }
  }
  return ids;
};

export const resolveReservedAppendTargets = <TBrand extends SafeIdType>(
  reserved: unknown,
  rows: readonly CorpusIndexRow<TBrand>[],
): Map<SafeId<TBrand>, ReservedAppendTargets> => {
  let returned: unknown[] = [];
  if (Array.isArray(reserved)) {
    returned = reserved;
  } else if (isRecord(reserved) && Array.isArray(reserved["rows"])) {
    returned = reserved["rows"];
  }
  const byId = new Map<string, SafeId<TBrand>>(
    rows.map((row) => [row.id, row.id]),
  );
  const targets = new Map<SafeId<TBrand>, ReservedAppendTargets>();
  for (const entry of returned) {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      !Array.isArray(entry["pendingIndexIds"]) ||
      !entry["pendingIndexIds"].every(
        (pendingIndexId) => typeof pendingIndexId === "string",
      ) ||
      typeof entry["pendingRevision"] !== "number" ||
      !Number.isInteger(entry["pendingRevision"]) ||
      entry["pendingRevision"] < 0
    ) {
      continue;
    }
    const id = byId.get(entry["id"]);
    if (id !== undefined) {
      targets.set(id, {
        indexIds: entry["pendingIndexIds"],
        revision: entry["pendingRevision"],
        // Absent flag reads as true: deleting when unsure is the safe
        // direction, skipping is only ever justified by explicit proof.
        mayHaveCopy: entry["mayHaveCopy"] !== false,
      });
    }
  }
  return targets;
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

export type FencedRemoteEffect<T> = {
  /** The remote operation; no database transaction may remain open here. */
  effect: () => Promise<T>;
  /**
   * Durable compensation for a remote mutation which completed after its
   * writer lease was lost. Required so a newly acquired writer cannot clear
   * an older reservation and strand that older physical effect.
   */
  onLeaseLost: () => Promise<void>;
};

type GuardRemoteEffect = <T>(effect: FencedRemoteEffect<T>) => Promise<T>;
type BeforeDatabaseMark = (tx: Transaction) => Promise<void>;
type ReserveExternalAppend<
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
> = (
  tx: Transaction,
  args: { generation: string; rows: readonly TRow[] },
) => Promise<Map<SafeId<TBrand>, ReservedAppendTargets>>;
type RecoverRemoteEffectLeaseLoss<TBrand extends SafeIdType> = (args: {
  entityIds: readonly SafeId<TBrand>[];
  indexId: string;
}) => Promise<void>;

type BackfillSelectedRowsOptions<
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
> =
  | {
      type: "incremental";
      readConcurrency?: number;
    }
  | {
      type: "fenced-incremental";
      beforeDatabaseMark: BeforeDatabaseMark;
      beforeRemoteEffect: GuardRemoteEffect;
      recoverRemoteEffectLeaseLoss: RecoverRemoteEffectLeaseLoss<TBrand>;
      reserveExternalAppend: ReserveExternalAppend<TBrand, TRow>;
      readConcurrency?: number;
    }
  | ({
      type: "generation-rebuild";
    } & GenerationRebuildBackfillOptions<TBrand, TRow>);

type GenerationBackfillRowsOptions<
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
> = {
  beforeDatabaseMark: BeforeDatabaseMark;
  beforeRemoteEffect: GuardRemoteEffect;
  recoverRemoteEffectLeaseLoss: RecoverRemoteEffectLeaseLoss<TBrand>;
  reserveExternalAppend: ReserveExternalAppend<TBrand, TRow>;
  readConcurrency?: number;
};

/**
 * A generation rebuild runs two shapes of walk through one entry point,
 * and they need different commit semantics: the snapshot pages are bulk
 * (`auto`, verified by a census afterwards) while the pending queue of a
 * completed generation is the live path every newly ingested decision
 * goes through (`wait_for`, because its acceptance is persisted). The
 * `type` discriminator cannot tell them apart, so the caller states it.
 */
export type GenerationRebuildBackfillOptions<
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
> = GenerationBackfillRowsOptions<TBrand, TRow> & {
  commit: CorpusIndexCommitMode;
  /**
   * Where a batch spent its wall clock, reported once per call. A rebuild
   * page is a chain of object reads, engine requests and short
   * transactions; which of them dominates is not derivable from the
   * indexed count, and reading it from the outside means timing the whole
   * page and guessing. Optional, so only the paths that report it pay for
   * it.
   */
  onTiming?: (timing: CorpusBackfillTiming) => void;
};

/**
 * Wall-clock split of one backfill call, in milliseconds. Phases are
 * sequential, so they sum to roughly the call's own duration; `documents`
 * and `engineRequests` are the units behind the ingest figure.
 */
export type CorpusBackfillTiming = {
  /** Canonical object reads for the batch (bounded concurrency). */
  readMs: number;
  /** Durable append reservations and index existence checks. */
  reserveMs: number;
  /** Engine removal tasks: replay cleanup and unrecorded-copy cleanup. */
  removeMs: number;
  /** Engine ingest requests, including any wait the commit mode implies. */
  ingestMs: number;
  /** Compare-and-set marks and their audit rows. */
  markMs: number;
  engineRequests: number;
  documents: number;
};

type FencedIncrementalBackfillOptions<
  TBrand extends SafeIdType,
  TRow extends CorpusIndexRow<TBrand>,
> = GenerationBackfillRowsOptions<TBrand, TRow>;

export type ReservedAppendTargets = {
  indexIds: readonly string[];
  revision: number;
  /**
   * Whether anything may have reached the engine for this row before this
   * reservation: an earlier reservation crossed the append boundary, or a
   * committed copy exists. The projection trigger seeds rows with neither
   * marker, so false is proof there is nothing to delete.
   */
  mayHaveCopy: boolean;
};

type CorpusIndexMarkMode<TBrand extends SafeIdType> =
  | { type: "incremental" }
  | {
      generation: string;
      reservations: ReadonlyMap<SafeId<TBrand>, ReservedAppendTargets>;
      type: "fenced-incremental" | "generation-rebuild";
    };

type IngestBatchWithGuardArgs = {
  client: CorpusIndexClient;
  commit: CorpusIndexCommitMode;
  indexId: string;
  ndjson: string;
} & (
  | {
      beforeRemoteEffect: GuardRemoteEffect;
      onLeaseLost: () => Promise<void>;
    }
  | {
      beforeRemoteEffect?: undefined;
      onLeaseLost?: undefined;
    }
);

const ingestBatchWithGuard = async ({
  beforeRemoteEffect,
  commit,
  indexId,
  ndjson,
  onLeaseLost,
  client,
}: IngestBatchWithGuardArgs): Promise<Result<void, CorpusIndexError>> => {
  const effect = async () => await client.ingestBatch(indexId, ndjson, commit);
  if (beforeRemoteEffect === undefined) {
    return await effect();
  }
  const guarded = await Result.tryPromise({
    try: async () => await beforeRemoteEffect({ effect, onLeaseLost }),
    catch: corpusIndexErrorFromThrown,
  });
  return guarded.isErr() ? Result.err(guarded.error) : guarded.value;
};

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
  /** Physical indexes recorded for this rebuild generation. */
  generationProjectionIndexIds: (row: TRow) => readonly string[];
  /**
   * Compare-and-set every row's selected state to indexed, within the
   * caller's transaction, as ONE statement. Returns the ids that were
   * marked; a missing id is a CAS miss (a concurrent refresh moved the
   * row on). One statement rather than a per-row loop: a bulk build
   * marks hundreds of rows per request, and per-row round-trips were
   * the dominant batch cost.
   */
  markIndexedBatch: (
    tx: Transaction,
    args: {
      rows: readonly TRow[];
      indexId: string;
      mode: CorpusIndexMarkMode<TBrand>;
      now: Date;
    },
  ) => Promise<Set<SafeId<TBrand>>>;
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
  /**
   * Atomically record document audit rows and the engine task that carries
   * their asynchronous deletion. A successful task without this durable
   * watermark is not settled evidence, so persistence failure must fail the
   * page and let replay create a newer task.
   */
  recordDeleteJobs: (
    scopedDb: ScopedDb,
    args: {
      indexId: string;
      jobs: readonly CorpusJobInput<TBrand>[];
      opstamp: number | null;
    },
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

/** Waits for every sibling before exposing the first rejection in input order. */
export const settleAll = async <T>(
  promises: readonly Promise<T>[],
): Promise<T[]> => {
  const outcomes = await Promise.allSettled(promises);
  const values: T[] = [];
  let firstError: unknown;
  let rejected = false;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      values.push(outcome.value);
      continue;
    }
    if (!rejected) {
      firstError = outcome.reason;
      rejected = true;
    }
  }
  if (rejected) {
    throw firstError;
  }
  return values;
};

/** Waits for best-effort cleanup and reports every failure without throwing. */
export const settleAllCleanup = async (
  promises: readonly Promise<unknown>[],
  reportError: (error: unknown) => void,
): Promise<void> => {
  const outcomes = await Promise.allSettled(promises);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      reportError(outcome.reason);
    }
  }
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
  const clientForGeneration = (generation: string): CorpusIndexClient =>
    getCorpusIndexClient(
      corpusIndexClusterForGeneration(adapter.family, generation),
    );
  const clientForIndexId = (indexId: string): CorpusIndexClient =>
    clientForGeneration(corpusIndexGeneration(indexId));
  const legacyWriterClientForGeneration = (
    generation: string,
  ): CorpusIndexClient => {
    const cluster = corpusIndexClusterForGeneration(adapter.family, generation);
    if (cluster !== "q08") {
      return panic(
        `Legacy ${adapter.family} corpus indexer cannot write final generation ${generation}`,
      );
    }
    return getCorpusIndexClient(cluster);
  };

  // Per-jurisdiction indexes are created on first write. Cache the ids we
  // have confirmed this process so we don't probe corpus index every batch.
  const ensuredIndexes = new Set<string>();

  const ensureIndex = async ({
    beforeRemoteEffect,
    client,
    indexId,
  }: {
    beforeRemoteEffect?: GuardRemoteEffect;
    client: CorpusIndexClient;
    indexId: string;
  }): Promise<Result<void, CorpusIndexError>> => {
    if (ensuredIndexes.has(indexId)) {
      return Result.ok(undefined);
    }
    const indexExists = async () => await client.indexExists(indexId);
    const exists = beforeRemoteEffect
      ? await beforeRemoteEffect({
          effect: indexExists,
          // A probe has no physical mutation to compensate.
          onLeaseLost: async () => await Promise.resolve(),
        })
      : await indexExists();
    if (exists.isErr()) {
      return Result.err(exists.error);
    }
    if (!exists.value) {
      const createIndex = async () =>
        await client.createIndex(corpusIndexConfig(adapter.family, indexId));
      const created = beforeRemoteEffect
        ? await beforeRemoteEffect({
            effect: createIndex,
            // An empty index is a safe fixed point; document writes carry
            // explicit compensation below.
            onLeaseLost: async () => await Promise.resolve(),
          })
        : await createIndex();
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
    // The stride drives the chunk loop; anything below 1 (or non-finite)
    // would stall or skip rows, so it is clamped rather than trusted.
    // Counted in rows: a passage row issues up to two object reads, so the
    // in-flight request ceiling is twice this value.
    const stride = Number.isFinite(readConcurrency)
      ? Math.max(1, Math.floor(readConcurrency))
      : INDEX_CONCURRENCY;
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
    for (let i = 0; i < rows.length; i += stride) {
      const slice = rows.slice(i, i + stride);
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
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one batched insert per index; the iteration count is index groups, not rows
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
  /**
   * Fenced callers pass both halves of the guard or neither. Kept as its own
   * union and intersected at each use: routing it through `Omit` flattens the
   * branches into independent optional properties, and the pair stops being
   * correlated for narrowing.
   */
  type RemoteEffectGuard =
    | {
        beforeRemoteEffect: GuardRemoteEffect;
        onLeaseLost: () => Promise<void>;
      }
    | {
        beforeRemoteEffect?: undefined;
        onLeaseLost?: undefined;
      };

  type RemoveTargets = {
    client: CorpusIndexClient;
    indexId: string;
    operation: "delete" | "redact";
    scopedDb: ScopedDb;
  };

  type RemoveManyWithOptionsArgs = RemoveTargets & {
    entityIds: readonly SafeId<TBrand>[];
  } & RemoteEffectGuard;

  type RemoveWithOptionsArgs = RemoveTargets & {
    entityId: SafeId<TBrand>;
  } & RemoteEffectGuard;

  const removeManyWithOptions = async ({
    beforeRemoteEffect,
    client,
    entityIds,
    indexId,
    onLeaseLost,
    operation,
    scopedDb,
  }: RemoveManyWithOptionsArgs): Promise<Result<void, CorpusIndexError>> => {
    if (entityIds.length === 0) {
      return Result.ok(undefined);
    }
    const deleteByQuery = async () =>
      await client.deleteByQuery(
        indexId,
        corpusDocumentsDeleteQuery(entityIds),
      );
    let deleted: Awaited<ReturnType<typeof deleteByQuery>>;
    if (beforeRemoteEffect === undefined) {
      deleted = await deleteByQuery();
    } else {
      const guarded = await Result.tryPromise({
        try: async () =>
          await beforeRemoteEffect({
            effect: deleteByQuery,
            onLeaseLost,
          }),
        catch: corpusIndexErrorFromThrown,
      });
      deleted = guarded.isErr() ? Result.err(guarded.error) : guarded.value;
    }
    // A retired generation is already at the requested fixed point. Treating
    // its missing index as a successful delete keeps cleanup idempotent and
    // avoids retrying an index that can no longer contain the document.
    const result =
      deleted.isErr() && deleted.error.status === 404
        ? Result.ok(null)
        : deleted;
    // One audit row per entity however many entities shared the task: the
    // trail records what happened to a document, not what carried it.
    await adapter.recordDeleteJobs(scopedDb, {
      indexId,
      jobs: entityIds.map((entityId) => ({
        entityId,
        contentHash: null,
        operation,
        status: result.isErr() ? ("failed" as const) : ("succeeded" as const),
        ...(result.isErr()
          ? { errorMessage: result.error.message.slice(0, 2048) }
          : {}),
      })),
      opstamp: result.isOk() ? (result.value?.opstamp ?? null) : null,
    });
    return result.isErr() ? result : Result.ok(undefined);
  };

  // Narrows on `args`, not on destructured locals: destructuring splits the
  // guard pair into independent variables, and testing one of them then tells
  // the checker nothing about the other.
  const removeWithOptions = async (
    args: RemoveWithOptionsArgs,
  ): Promise<Result<void, CorpusIndexError>> => {
    const { entityId, indexId, operation, scopedDb } = args;
    return await removeManyWithOptions(
      args.beforeRemoteEffect === undefined
        ? {
            client: args.client,
            entityIds: [entityId],
            indexId,
            operation,
            scopedDb,
          }
        : {
            beforeRemoteEffect: args.beforeRemoteEffect,
            client: args.client,
            entityIds: [entityId],
            indexId,
            onLeaseLost: args.onLeaseLost,
            operation,
            scopedDb,
          },
    );
  };

  const remove = async (
    entityId: SafeId<TBrand>,
    scopedDb: ScopedDb,
    indexId: string,
    operation: "delete" | "redact" = "delete",
  ): Promise<Result<void, CorpusIndexError>> =>
    await removeWithOptions({
      client: clientForIndexId(indexId),
      entityId,
      indexId,
      operation,
      scopedDb,
    });

  type PublicRemoveWithOptionsArgs = {
    indexId: string;
    operation: "delete" | "redact";
    scopedDb: ScopedDb;
    entityId: SafeId<TBrand>;
  } & RemoteEffectGuard;

  const removeFenced = async (
    args: PublicRemoveWithOptionsArgs,
  ): Promise<Result<void, CorpusIndexError>> => {
    const client = clientForIndexId(args.indexId);
    if (args.beforeRemoteEffect === undefined) {
      return await removeWithOptions({
        client,
        entityId: args.entityId,
        indexId: args.indexId,
        operation: args.operation,
        scopedDb: args.scopedDb,
      });
    }
    return await removeWithOptions({
      beforeRemoteEffect: args.beforeRemoteEffect,
      client,
      entityId: args.entityId,
      indexId: args.indexId,
      onLeaseLost: args.onLeaseLost,
      operation: args.operation,
      scopedDb: args.scopedDb,
    });
  };

  /**
   * Index a batch of corpus-backed rows into the given generation. Two-query
   * missing/stale split mirrors backfillSearchIndex: `missing` = not yet in
   * this generation; `stale` = content changed since last push. Reserves a
   * quarter of the batch for stale so re-indexes are not starved by a
   * missing-doc backlog. Returns the number indexed.
   */
  let staleSkips = 0;

  const backfillWithOptions = async (
    scopedDb: ScopedDb,
    batchSize: number,
    generation: string,
    options: BackfillSelectedRowsOptions<TBrand, TRow>,
  ): Promise<FencedBackfillBatchResult> => {
    const staleReserved = Math.max(1, Math.floor(batchSize / 4));
    // A due duty batch cedes one missing slot up front so granting the
    // stale scan capacity below cannot push the batch past its requested
    // size (batchSize 1 becomes a stale-only batch on the due call).
    const dutyDue = staleSkips >= STALE_SCAN_DUTY_CYCLE - 1;
    const missingLimit = Math.max(
      dutyDue ? 0 : 1,
      batchSize - staleReserved - (dutyDue ? 1 : 0),
    );

    const missing =
      missingLimit === 0
        ? []
        : await adapter.selectMissing(scopedDb, {
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
      missing.length >= missingLimit && !dutyDue
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

    let rows: TRow[] = [...missing, ...stale];
    if (rows.length === 0 && dutyDue && missingLimit < batchSize) {
      // A stale-only duty batch that found nothing must not report zero —
      // callers treat zero as completion. Fall back to a full missing
      // selection so the duty batch costs at most one extra query.
      rows = await adapter.selectMissing(scopedDb, {
        generation,
        limit: batchSize,
      });
    }
    if (rows.length === 0) {
      return { indexed: 0, status: FENCED_BACKFILL_BATCH_STATUS.COMPLETE };
    }

    const { indexed } = await backfillSelectedRows(
      scopedDb,
      rows,
      generation,
      options,
    );
    return indexed > 0
      ? { indexed, status: FENCED_BACKFILL_BATCH_STATUS.ADVANCED }
      : { indexed: 0, status: FENCED_BACKFILL_BATCH_STATUS.RETRY };
  };

  const backfill = async (
    scopedDb: ScopedDb,
    batchSize: number,
    generation: string,
    options: { readConcurrency?: number } = {},
  ): Promise<number> => {
    const { indexed } = await backfillWithOptions(
      scopedDb,
      batchSize,
      generation,
      { ...options, type: "incremental" },
    );
    return indexed;
  };

  const backfillFenced = async (
    scopedDb: ScopedDb,
    batchSize: number,
    generation: string,
    options: FencedIncrementalBackfillOptions<TBrand, TRow>,
  ): Promise<FencedBackfillBatchResult> =>
    await backfillWithOptions(scopedDb, batchSize, generation, {
      ...options,
      type: "fenced-incremental",
    });

  const backfillSelectedRows = async (
    scopedDb: ScopedDb,
    rows: TRow[],
    generation: string,
    options: BackfillSelectedRowsOptions<TBrand, TRow>,
  ): Promise<CorpusBackfillOutcome> => {
    if (rows.length === 0) {
      return { indexed: 0, refreshed: 0, unread: 0 };
    }
    const timing: CorpusBackfillTiming = {
      readMs: 0,
      reserveMs: 0,
      removeMs: 0,
      ingestMs: 0,
      markMs: 0,
      engineRequests: 0,
      documents: 0,
    };
    try {
      return await backfillSelectedRowsTimed(
        scopedDb,
        rows,
        generation,
        options,
        timing,
      );
    } finally {
      // Reported however the batch ends, so a batch that fails still says
      // where its time went — a page that gets slow and a page that starts
      // failing are often the same page.
      if (options.type === "generation-rebuild") {
        options.onTiming?.(timing);
      }
    }
  };

  const backfillSelectedRowsTimed = async (
    scopedDb: ScopedDb,
    rows: TRow[],
    generation: string,
    options: BackfillSelectedRowsOptions<TBrand, TRow>,
    timing: CorpusBackfillTiming,
  ): Promise<CorpusBackfillOutcome> => {
    const client = legacyWriterClientForGeneration(generation);
    // Load text (S3) with bounded concurrency, then ingest one NDJSON batch.
    // A per-document read failure fails only that document; record it and let
    // the rest still commit.
    const fetchFulltext: FetchFulltext<TBrand> = async (id) =>
      await adapter.fetchFulltext(scopedDb, id);
    // Monotonic: a wall-clock step backwards would make a phase read
    // negative, and the whole point of the split is that it is comparable
    // across pages.
    const elapsedSince = (startedAt: number) =>
      Math.round(performance.now() - startedAt);
    const readStartedAt = performance.now();
    const { built, readFailures } = await loadDocsForBatch(rows, {
      generation,
      fetchFulltext,
      ...(options.readConcurrency === undefined
        ? {}
        : { readConcurrency: options.readConcurrency }),
    });
    timing.readMs = elapsedSince(readStartedAt);
    await recordReadFailures(scopedDb, readFailures, generation);

    // Route each row's documents to its physical index (`corpusIndexId`: per
    // jurisdiction, or per index group), grouping so each index gets one
    // NDJSON ingest.
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
    let refreshed = 0;
    let firstError: CorpusIndexError | null = null;

    const reserveAndEnsureGroup = async (
      indexId: string,
      group: typeof built,
    ) => {
      const reserveStartedAt = performance.now();
      const reservedTargets =
        options.type === "incremental"
          ? null
          : await scopedDb(async (tx) => {
              await options.beforeDatabaseMark(tx);
              return await options.reserveExternalAppend(tx, {
                generation,
                rows: group.map(({ row }) => row),
              });
            });
      // A reservation CAS miss means a concurrent refresh moved the row
      // after the batch read. Do not let an old payload cross the external
      // append boundary; the newer row remains in the durable pending set.
      const reservedGroup =
        reservedTargets === null
          ? group
          : group.filter(({ row }) => reservedTargets.has(row.id));
      if (reservedGroup.length === 0) {
        timing.reserveMs += elapsedSince(reserveStartedAt);
        return { ensured: null, reservedGroup, reservedTargets };
      }
      // A new generation may not have an index for this jurisdiction yet.
      // Create it before replay cleanup so an expected empty target does not
      // turn the delete into a terminal 404.
      const ensured = await ensureIndex({
        ...(options.type === "incremental"
          ? {}
          : { beforeRemoteEffect: options.beforeRemoteEffect }),
        client,
        indexId,
      });
      timing.reserveMs += elapsedSince(reserveStartedAt);
      return { ensured, reservedGroup, reservedTargets };
    };

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
        const reservation = await reserveAndEnsureGroup(indexId, group);
        const { ensured, reservedGroup, reservedTargets } = reservation;
        // A row the reservation dropped was moved by a concurrent refresh
        // before this batch reached the append boundary — the same deferral
        // the mark's compare-and-set reports below, just caught earlier.
        refreshed += group.length - reservedGroup.length;
        if (ensured === null) {
          continue;
        }
        if (ensured.isErr()) {
          firstError ??= ensured.error;
          groupFailures.push(...failedIndexJobs(reservedGroup, ensured.error));
          continue;
        }

        // Ingest appends; it never replaces. Before re-ingesting, delete the
        // previously indexed copies from wherever they live (the same index for
        // a content refresh, another jurisdiction index for a corrected
        // country), or stale copies keep matching old text. `remove` deletes by
        // `document_id`, so a row whose previous version split into a different
        // number of passages leaves nothing behind. Same generation only:
        // generation rebuilds replace whole indexes. Engine delete tasks only
        // affect splits that already exist, so the copies ingested below are not
        // at risk.
        const moved = reservedGroup.flatMap(({ row }) => {
          // A generation page can be replayed after the external append but
          // before its database mark commits. Delete its deterministic target
          // copies first, so a retry converges instead of appending duplicates.
          const previousIndexes = new Set<string>();
          const durableTargets =
            reservedTargets === null ? undefined : reservedTargets.get(row.id);
          // Delete only when something may actually be there: an earlier
          // reservation that crossed the append boundary, or a committed
          // copy. The projection trigger seeds pending rows with neither, so
          // a backlog drain — almost entirely never-appended rows — skips
          // the per-row engine round-trip that was its entire cost profile.
          if (durableTargets?.mayHaveCopy === true) {
            previousIndexes.add(indexId);
            for (const projectionIndexId of adapter.generationProjectionIndexIds(
              row,
            )) {
              previousIndexes.add(projectionIndexId);
            }
            for (const reservedIndexId of durableTargets.indexIds) {
              previousIndexes.add(reservedIndexId);
            }
          }
          if (row.indexedGeneration?.startsWith(`${generation}_`) === true) {
            previousIndexes.add(row.indexedGeneration);
          }
          return [...previousIndexes].map((oldIndexId) => ({
            id: row.id,
            oldIndexId,
          }));
        });
        // Grouped by target index, never issued per row. A delete task is
        // planned against every split whose delete opstamp is behind it, so
        // one task per row makes planning O(rows x splits) — a cost the
        // engine pays asynchronously, long after these calls return, and one
        // that compounds until the planner can no longer converge. The number
        // of tasks a batch emits must scale with the indexes it touches
        // (jurisdictions), not with the rows it carries.
        const movedByIndex = new Map<string, SafeId<TBrand>[]>();
        for (const entry of moved) {
          const forIndex = movedByIndex.get(entry.oldIndexId);
          if (forIndex === undefined) {
            movedByIndex.set(entry.oldIndexId, [entry.id]);
          } else {
            forIndex.push(entry.id);
          }
        }
        // Chunked here rather than inside the remove: the batch is what knows
        // how many ids there are, and one call staying one remote task is what
        // keeps the task count readable at this call site.
        const deleteUnits: { entityIds: SafeId<TBrand>[]; indexId: string }[] =
          [];
        for (const [oldIndexId, ids] of movedByIndex) {
          for (const chunk of deleteQueryChunks(ids)) {
            deleteUnits.push({ entityIds: chunk, indexId: oldIndexId });
          }
        }
        let staleError: CorpusIndexError | null = null;
        const removeStartedAt = performance.now();
        for (const unit of deleteUnits) {
          timing.engineRequests += 1;
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each unit is already one chunked delete task per index; stops at the first error
          const removed = await removeManyWithOptions({
            ...(options.type === "incremental"
              ? {}
              : {
                  beforeRemoteEffect: options.beforeRemoteEffect,
                  onLeaseLost: async () =>
                    await options.recoverRemoteEffectLeaseLoss({
                      entityIds: unit.entityIds,
                      indexId: unit.indexId,
                    }),
                }),
            client,
            entityIds: unit.entityIds,
            indexId: unit.indexId,
            operation: "delete",
            scopedDb,
          });
          if (removed.isErr()) {
            staleError = removed.error;
            break;
          }
        }
        timing.removeMs += elapsedSince(removeStartedAt);
        if (staleError) {
          firstError ??= staleError;
          continue;
        }

        // One group can exceed a single request's byte budget once rows project
        // to many documents, so it goes out as a sequence of requests. Each is
        // committed on its own: a later request failing must not un-commit the
        // rows an earlier one already landed, because those documents are in the
        // index and re-ingesting them next cycle would append a second copy that
        // nothing points at.
        for (const { entries, ndjson } of splitIngestRequests(
          reservedGroup,
          LIMITS.corpusIndexIngestMaxBytes,
        )) {
          const ingestStartedAt = performance.now();
          const ingest = await ingestBatchWithGuard({
            // Both incremental shapes are the steady state: their whole
            // job is to make a newly written row searchable, and the
            // mark they take afterwards is what stops anything selecting
            // it again. Only a rebuild's caller gets to choose, because
            // only a rebuild has a census behind it.
            commit:
              options.type === "generation-rebuild"
                ? options.commit
                : CORPUS_INDEX_COMMIT.waitFor,
            ...(options.type === "incremental"
              ? {}
              : {
                  beforeRemoteEffect: options.beforeRemoteEffect,
                  onLeaseLost: async () =>
                    await options.recoverRemoteEffectLeaseLoss({
                      entityIds: entries.map(({ row }) => row.id),
                      indexId,
                    }),
                }),
            client,
            indexId,
            ndjson,
          });
          timing.ingestMs += elapsedSince(ingestStartedAt);
          timing.engineRequests += 1;
          for (const { docs } of entries) {
            timing.documents += docs.length;
          }

          if (ingest.isErr()) {
            firstError ??= ingest.error;
            // Only the rows actually attempted are recorded failed; the rest of
            // the group is left for the next cycle rather than audited as a
            // failure that never happened.
            groupFailures.push(...failedIndexJobs(entries, ingest.error));
            break;
          }

          const casMissed = new Set<SafeId<TBrand>>();
          const markStartedAt = performance.now();
          await scopedDb(async (tx) => {
            // audit: skip — search index maintenance; rebuilds derived state
            if (options.type !== "incremental") {
              await options.beforeDatabaseMark(tx);
            }
            // Compare-and-set on each row's selected state: a concurrent
            // re-ingest clears indexedHash (possibly leaving it null-to-null
            // when the row was already pending) and bumps updatedAt, and an
            // unconditional write would mask that refresh so the stale index
            // document would never be retried. All rows go in one statement;
            // per-row round-trips dominated bulk-build batch cost.
            let mode: CorpusIndexMarkMode<TBrand>;
            if (options.type === "incremental") {
              mode = { type: "incremental" };
            } else {
              if (reservedTargets === null) {
                panic("fenced corpus append reached mark without reservations");
              }
              const reservations = new Map<
                SafeId<TBrand>,
                ReservedAppendTargets
              >();
              for (const { row } of entries) {
                const rowReservation = reservedTargets.get(row.id);
                if (rowReservation === undefined) {
                  panic("reserved corpus row reached mark without its epoch");
                }
                reservations.set(row.id, rowReservation);
              }
              mode = { generation, reservations, type: options.type };
            }
            const marked = await adapter.markIndexedBatch(tx, {
              rows: entries.map(({ row }) => row),
              indexId,
              mode,
              now,
            });
            for (const { row } of entries) {
              if (!marked.has(row.id)) {
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
          timing.markMs += elapsedSince(markStartedAt);
          // A missed CAS means a refresh outpaced this batch after the ingest
          // appended its documents: the row carries no generation pointer to
          // them, so delete the unrecorded copies now; the refreshed row is
          // re-indexed by a later cycle.
          const missedStartedAt = performance.now();
          for (const chunk of deleteQueryChunks([...casMissed])) {
            timing.engineRequests += 1;
            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each chunk is already one batched delete task for this index
            const removed = await removeManyWithOptions({
              ...(options.type === "incremental"
                ? {}
                : {
                    beforeRemoteEffect: options.beforeRemoteEffect,
                    onLeaseLost: async () =>
                      await options.recoverRemoteEffectLeaseLoss({
                        entityIds: chunk,
                        indexId,
                      }),
                  }),
              client,
              entityIds: chunk,
              indexId,
              operation: "delete",
              scopedDb,
            });
            if (removed.isErr()) {
              firstError ??= removed.error;
            }
          }
          timing.removeMs += elapsedSince(missedStartedAt);
          indexed += entries.length - casMissed.size;
          refreshed += casMissed.size;
        }
      } finally {
        // Always lands, including when the code above threw. The audit
        // trail is how an operator sees which rows the indexer could not
        // place; a row that is neither indexed nor recorded failed is
        // invisible.
        if (groupFailures.length > 0) {
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one batched insert per index group, written in that group's own finally
          await adapter.recordJobs(scopedDb, groupFailures, indexId);
        }
      }
    }

    // Surface a failure so the daemon retries the un-indexed groups.
    if (firstError) {
      throw firstError;
    }

    // Reached only when every group was attempted, so the three counters
    // partition the selection. Anything else is an accounting bug in this
    // function, not a condition a caller could act on.
    const unread = readFailures.length;
    if (indexed + refreshed + unread !== rows.length) {
      panic("corpus backfill outcome does not account for every selected row");
    }
    return { indexed, refreshed, unread };
  };

  const backfillRows = async (
    scopedDb: ScopedDb,
    rows: readonly TRow[],
    generation: string,
    options: GenerationRebuildBackfillOptions<TBrand, TRow>,
  ): Promise<CorpusBackfillOutcome> =>
    await backfillSelectedRows(scopedDb, [...rows], generation, {
      ...options,
      type: "generation-rebuild",
    });

  return {
    loadDocsForBatch,
    backfill,
    backfillFenced,
    backfillRows,
    remove,
    removeFenced,
  };
};
