import { Result, TaggedError, panic } from "better-result";

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
  /** The records no longer fit the bounds they were prepared under. */
  OUT_OF_BOUNDS: "out-of-bounds",
  /** A database operation exceeded its deadline. */
  TIMEOUT: "timeout",
  /**
   * A database condition that passes on a retry: a serialization failure, a
   * deadlock, a lost connection. The record is not at fault.
   */
  TRANSIENT: "transient",
  /** A concurrent writer moved a decision; its reconciliation did not settle. */
  CONTENTION: "contention",
  RAW_WRITE: "raw-write",
  PACK_WRITE: "pack-write",
  /** The record could not be applied; its failure is in the ingestion ledger. */
  RECORD_REJECTED: "record-rejected",
  /** A record's failure could not be written to the ingestion ledger. */
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
  /**
   * `record-rejected` only when every unsettled record is a rejection the
   * ledger holds; anything retryable, or an unwritten ledger, outranks it.
   */
  reason: CaseLawBatchFailureReason;
  /** Records that did not settle, including any the batch never reached. */
  unsettled: number;
  /** The first unsettled records the batch reached, in batch order. */
  records: readonly UnsettledBatchRecord[];
}> {}

/**
 * Text as UTF-8, a number or boolean as its text, and a binary payload (any
 * typed-array view, `Buffer` included) at its byte length. Walked rather than
 * serialized, so a view is never measured through its own `toJSON`.
 */
const encodedValueBytes = (value: unknown, ancestors: Set<object>): number => {
  switch (typeof value) {
    case "string":
      return Buffer.byteLength(value, "utf-8");
    case "number":
    case "boolean":
    case "bigint":
      return String(value).length;
    case "object":
      break;
    default:
      return 0;
  }
  if (value === null) {
    return 0;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (ancestors.has(value)) {
    return panic("An ingestion record contains itself");
  }
  ancestors.add(value);
  let bytes = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      bytes += encodedValueBytes(item, ancestors);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      bytes += Buffer.byteLength(key, "utf-8");
      bytes += encodedValueBytes(child, ancestors);
    }
  }
  ancestors.delete(value);
  return bytes;
};

export const encodedIngestionResultBytes = (
  decision: IngestionResult,
): number => encodedValueBytes(decision, new Set());

export const DECISION_ADMISSION = {
  WITHIN_BOUNDS: "within-bounds",
  /** One record that alone exceeds the byte bound, admitted by itself. */
  OVERSIZED_RECORD: "oversized-record",
} as const;

/** Module-private, so admitted records are constructible only below. */
const ADMITTED: unique symbol = Symbol("admittedCaseLawDecisions");

/** Records admitted for one application, measured when admitted. */
export type AdmittedDecisions =
  | {
      readonly [ADMITTED]: true;
      readonly admission: typeof DECISION_ADMISSION.WITHIN_BOUNDS;
      readonly decisions: readonly IngestionResult[];
      readonly encodedBytes: number;
    }
  | {
      readonly [ADMITTED]: true;
      readonly admission: typeof DECISION_ADMISSION.OVERSIZED_RECORD;
      readonly decisions: readonly [IngestionResult];
      readonly encodedBytes: number;
    };

export type BoundedCaseLawIngestionBatch = Extract<
  AdmittedDecisions,
  { admission: typeof DECISION_ADMISSION.WITHIN_BOUNDS }
>;

type AdmittedPart = {
  /** Position of the part's first record in the input. */
  start: number;
  admitted: AdmittedDecisions;
};

/**
 * Split records into parts in input order: each within the record and byte
 * bounds, except a record over the byte bound on its own, which is a part of
 * its own and says so.
 */
const admitParts = (decisions: readonly IngestionResult[]): AdmittedPart[] => {
  const { records, encodedBytes } = CASE_LAW_INGESTION_BATCH_LIMITS;
  const parts: AdmittedPart[] = [];
  let run: IngestionResult[] = [];
  let runStart = 0;
  let runBytes = 0;
  const closeRun = (): void => {
    if (run.length > 0) {
      parts.push({
        start: runStart,
        admitted: {
          [ADMITTED]: true,
          admission: DECISION_ADMISSION.WITHIN_BOUNDS,
          decisions: run,
          encodedBytes: runBytes,
        },
      });
    }
    run = [];
    runBytes = 0;
  };
  for (const [index, decision] of decisions.entries()) {
    const bytes = encodedIngestionResultBytes(decision);
    if (bytes > encodedBytes) {
      closeRun();
      parts.push({
        start: index,
        admitted: {
          [ADMITTED]: true,
          admission: DECISION_ADMISSION.OVERSIZED_RECORD,
          decisions: [decision],
          encodedBytes: bytes,
        },
      });
      continue;
    }
    if (run.length >= records || runBytes + bytes > encodedBytes) {
      closeRun();
    }
    if (run.length === 0) {
      runStart = index;
    }
    run.push(decision);
    runBytes += bytes;
  }
  closeRun();
  return parts;
};

/** A page's records as admitted parts, applied one after another. */
export const admitPageDecisions = (
  decisions: readonly IngestionResult[],
): AdmittedDecisions[] => admitParts(decisions).map(({ admitted }) => admitted);

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
 * one record, at most the record bound, no record over the byte bound, and
 * at most the byte bound in all.
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
  const parts = admitParts(decisions);
  const oversized = parts.find(
    ({ admitted }) =>
      admitted.admission === DECISION_ADMISSION.OVERSIZED_RECORD,
  );
  if (oversized !== undefined) {
    return boundsError(
      CASE_LAW_BATCH_BOUNDS_REASON.RECORD_TOO_LARGE,
      `Record ${oversized.start} encodes to ${oversized.admitted.encodedBytes} bytes, over the ${encodedBytes}-byte bound`,
      oversized.start,
    );
  }
  const [only, ...rest] = parts;
  if (
    only === undefined ||
    rest.length > 0 ||
    only.admitted.admission !== DECISION_ADMISSION.WITHIN_BOUNDS
  ) {
    const total = parts.reduce(
      (sum, { admitted }) => sum + admitted.encodedBytes,
      0,
    );
    return boundsError(
      CASE_LAW_BATCH_BOUNDS_REASON.TOO_MANY_BYTES,
      `A batch encodes to at most ${encodedBytes} bytes, not ${total}`,
    );
  }
  return Result.ok(only.admitted);
};
