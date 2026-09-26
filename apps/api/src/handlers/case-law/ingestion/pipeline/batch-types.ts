import { Result, TaggedError } from "better-result";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";

/**
 * What one applied batch may carry. The byte bound measures the records as
 * handed in (text as UTF-8, binary payloads at their length), not what their
 * stored payloads will weigh: the corpus pack keeps its own ceiling.
 */
export const CASE_LAW_INGESTION_BATCH_LIMITS = {
  records: 200,
  encodedBytes: 32 * 1024 * 1024,
} as const;

export const CASE_LAW_BATCH_BOUNDS_REASON = {
  EMPTY: "empty",
  TOO_MANY_RECORDS: "too-many-records",
  TOO_MANY_BYTES: "too-many-bytes",
  /** One record alone exceeds the byte bound; no split can carry it. */
  RECORD_TOO_LARGE: "record-too-large",
} as const;

type CaseLawBatchBoundsReason =
  (typeof CASE_LAW_BATCH_BOUNDS_REASON)[keyof typeof CASE_LAW_BATCH_BOUNDS_REASON];

class CaseLawBatchBoundsError extends TaggedError("CaseLawBatchBoundsError")<{
  message: string;
  reason: CaseLawBatchBoundsReason;
  /** The record that alone exceeds the byte bound, or null for the batch. */
  index: number | null;
}> {}

/** Why an applied batch returned no receipt. */
export const CASE_LAW_BATCH_FAILURE = {
  /** The source lease was not held when the batch ordered or settled. */
  LEASE_LOST: "lease-lost",
  ABORTED: "aborted",
  /** A database operation exceeded its deadline. */
  TIMEOUT: "timeout",
  /** A concurrent writer moved a decision; its reconciliation did not settle. */
  CONTENTION: "contention",
  RAW_WRITE: "raw-write",
  PACK_WRITE: "pack-write",
  /** The record could not be applied; its failure is in the ingestion ledger. */
  RECORD_REJECTED: "record-rejected",
  /** A rejected record's ledger row could not be written. */
  FAILURE_WRITE: "failure-write",
} as const;

export type CaseLawBatchFailureReason =
  (typeof CASE_LAW_BATCH_FAILURE)[keyof typeof CASE_LAW_BATCH_FAILURE];

type UnsettledBatchRecord = {
  /** Position in the prepared batch. */
  index: number;
  reason: CaseLawBatchFailureReason;
  caseNumber: string;
  sourceDocumentId: string | null;
};

export class CaseLawBatchApplyError extends TaggedError(
  "CaseLawBatchApplyError",
)<{
  message: string;
  reason: CaseLawBatchFailureReason;
  /** Records that did not settle, including any the batch never reached. */
  unsettled: number;
  /** The first unsettled records the batch reached, in batch order. */
  records: readonly UnsettledBatchRecord[];
}> {}

/** Module-private, so a bounded batch is constructible only below. */
const BOUNDED: unique symbol = Symbol("boundedCaseLawIngestionBatch");

export type BoundedCaseLawIngestionBatch = {
  readonly [BOUNDED]: true;
  readonly decisions: readonly IngestionResult[];
  readonly encodedBytes: number;
};

/** Text as UTF-8 plus binary payloads at their length. */
const encodedIngestionResultBytes = (decision: IngestionResult): number => {
  let binaryBytes = 0;
  const text = JSON.stringify(decision, (_key, value: unknown) => {
    if (value instanceof Uint8Array) {
      binaryBytes += value.byteLength;
      return undefined;
    }
    return typeof value === "bigint" ? value.toString() : value;
  });
  return Buffer.byteLength(text, "utf-8") + binaryBytes;
};

const boundsError = (
  reason: CaseLawBatchBoundsReason,
  message: string,
  index: number | null = null,
): Result<never, CaseLawBatchBoundsError> =>
  Result.err(new CaseLawBatchBoundsError({ message, reason, index }));

type PrepareCaseLawIngestionBatchOptions = {
  decisions: readonly IngestionResult[];
};

/**
 * Admit records into one batch, or refuse them before any write: at least
 * one record, at most the record bound, and at most the byte bound in all.
 */
export const prepareCaseLawIngestionBatch = ({
  decisions,
}: PrepareCaseLawIngestionBatchOptions): Result<
  BoundedCaseLawIngestionBatch,
  CaseLawBatchBoundsError
> => {
  const { records, encodedBytes } = CASE_LAW_INGESTION_BATCH_LIMITS;
  if (decisions.length === 0) {
    return boundsError(
      CASE_LAW_BATCH_BOUNDS_REASON.EMPTY,
      "A batch holds at least one record",
    );
  }
  if (decisions.length > records) {
    return boundsError(
      CASE_LAW_BATCH_BOUNDS_REASON.TOO_MANY_RECORDS,
      `A batch holds at most ${records} records, not ${decisions.length}`,
    );
  }
  let total = 0;
  for (const [index, decision] of decisions.entries()) {
    const bytes = encodedIngestionResultBytes(decision);
    if (bytes > encodedBytes) {
      return boundsError(
        CASE_LAW_BATCH_BOUNDS_REASON.RECORD_TOO_LARGE,
        `Record ${index} encodes to ${bytes} bytes, over the ${encodedBytes}-byte bound`,
        index,
      );
    }
    total += bytes;
  }
  if (total > encodedBytes) {
    return boundsError(
      CASE_LAW_BATCH_BOUNDS_REASON.TOO_MANY_BYTES,
      `A batch encodes to at most ${encodedBytes} bytes, not ${total}`,
    );
  }
  const batch: BoundedCaseLawIngestionBatch = {
    [BOUNDED]: true,
    decisions: [...decisions],
    encodedBytes: total,
  };
  return Result.ok(batch);
};

/**
 * Split a page into runs within the batch bounds, in page order. A record
 * over the byte bound on its own runs alone rather than being refused: a
 * page's records are applied whatever their size.
 */
export const partitionWithinBatchBounds = (
  decisions: readonly IngestionResult[],
): IngestionResult[][] => {
  const { records, encodedBytes } = CASE_LAW_INGESTION_BATCH_LIMITS;
  const runs: IngestionResult[][] = [];
  let run: IngestionResult[] = [];
  let runBytes = 0;
  for (const decision of decisions) {
    const bytes = encodedIngestionResultBytes(decision);
    if (
      run.length > 0 &&
      (run.length >= records || runBytes + bytes > encodedBytes)
    ) {
      runs.push(run);
      run = [];
      runBytes = 0;
    }
    run.push(decision);
    runBytes += bytes;
  }
  if (run.length > 0) {
    runs.push(run);
  }
  return runs;
};
