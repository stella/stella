import { Result, TaggedError, panic } from "better-result";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";

/** An upstream record that cannot safely become a decision. */
export type RejectedCaseLawIngestionRecord = {
  type: "rejected";
  recordKey: string;
  recordHash: string;
  language: string;
  primaryLabel?: string;
  reason: string;
  message: string;
  /** See `CaseLawIngestionBatchRecord`. */
  recordIdentity?: string;
};

/**
 * A record of one batch. `recordIdentity`, where the caller names one, is
 * the record's stable identity for the failure ledger: a record that fails
 * again under the same identity keeps its one ledger row.
 */
export type CaseLawIngestionBatchRecord =
  | { type: "decision"; decision: IngestionResult; recordIdentity?: string }
  | RejectedCaseLawIngestionRecord;

/** Column bound of `case_law_ingestion_failures.record_identity`. */
export const RECORD_IDENTITY_MAX_LENGTH = 256;

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
  INVALID_RECORD: "invalid-record",
  TOO_MANY_RECORDS: "too-many-records",
  TOO_MANY_BYTES: "too-many-bytes",
  /** One record alone exceeds the byte bound; no split can carry it. */
  RECORD_TOO_LARGE: "record-too-large",
} as const;

const validRejectedText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isValidRecordIdentity = (value: unknown): boolean =>
  value === undefined ||
  (validRejectedText(value) &&
    value.length <= RECORD_IDENTITY_MAX_LENGTH &&
    !value.includes("\u0000"));

const isValidRejectedRecord = (
  record: RejectedCaseLawIngestionRecord,
): boolean =>
  isValidRecordIdentity(record.recordIdentity) &&
  validRejectedText(record.recordKey) &&
  validRejectedText(record.recordHash) &&
  validRejectedText(record.language) &&
  (record.primaryLabel === undefined ||
    validRejectedText(record.primaryLabel)) &&
  validRejectedText(record.reason) &&
  validRejectedText(record.message);

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
  /**
   * Consecutive rejections stopped the batch before it reached every record;
   * the records it did not reach were never attempted.
   */
  FAILURE_STREAK: "failure-streak",
  /** A fault outside the records that the batch does not classify. */
  UNCLASSIFIED: "unclassified",
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
 * typed-array view, `Buffer` included) at its byte length. Structure is
 * charged as JSON writes it (quotes, `null`, brackets, separators), so no
 * value weighs nothing. Walked rather than serialized, so a view is never
 * measured through its own `toJSON`.
 */
const encodedValueBytes = (value: unknown, ancestors: Set<object>): number => {
  switch (typeof value) {
    case "string":
      return Buffer.byteLength(value, "utf-8") + 2;
    case "number":
    case "boolean":
    case "bigint":
      return String(value).length;
    case "object":
      break;
    case "undefined":
    case "function":
    case "symbol":
      return 0;
  }
  if (value === null) {
    return 4;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (ancestors.has(value)) {
    return panic("An ingestion record contains itself");
  }
  ancestors.add(value);
  // Brackets, then a separator per element and quotes and a colon per key.
  let bytes = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      bytes += 1 + encodedValueBytes(item, ancestors);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      bytes += Buffer.byteLength(key, "utf-8") + 4;
      bytes += encodedValueBytes(child, ancestors);
    }
  }
  ancestors.delete(value);
  return bytes;
};

export const encodedIngestionResultBytes = (
  decision: IngestionResult,
): number => encodedValueBytes(decision, new Set());

const encodedBatchRecordBytes = (
  record: CaseLawIngestionBatchRecord,
): number =>
  record.type === "decision"
    ? encodedIngestionResultBytes(record.decision)
    : encodedValueBytes(record, new Set());

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
      readonly batchRecords: readonly CaseLawIngestionBatchRecord[];
      readonly encodedBytes: number;
    }
  | {
      readonly [ADMITTED]: true;
      readonly admission: typeof DECISION_ADMISSION.OVERSIZED_RECORD;
      readonly decisions: readonly IngestionResult[];
      readonly batchRecords: readonly [CaseLawIngestionBatchRecord];
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
const admitParts = (
  batchRecords: readonly CaseLawIngestionBatchRecord[],
): AdmittedPart[] => {
  const { records, encodedBytes } = CASE_LAW_INGESTION_BATCH_LIMITS;
  const parts: AdmittedPart[] = [];
  let run: IngestionResult[] = [];
  let recordRun: CaseLawIngestionBatchRecord[] = [];
  let runStart = 0;
  let runBytes = 0;
  const closeRun = (): void => {
    if (recordRun.length > 0) {
      parts.push({
        start: runStart,
        admitted: {
          [ADMITTED]: true,
          admission: DECISION_ADMISSION.WITHIN_BOUNDS,
          decisions: run,
          batchRecords: recordRun,
          encodedBytes: runBytes,
        },
      });
    }
    run = [];
    recordRun = [];
    runBytes = 0;
  };
  for (const [index, record] of batchRecords.entries()) {
    const bytes = encodedBatchRecordBytes(record);
    if (bytes > encodedBytes) {
      closeRun();
      parts.push({
        start: index,
        admitted: {
          [ADMITTED]: true,
          admission: DECISION_ADMISSION.OVERSIZED_RECORD,
          decisions: record.type === "decision" ? [record.decision] : [],
          batchRecords: [record],
          encodedBytes: bytes,
        },
      });
      continue;
    }
    if (recordRun.length >= records || runBytes + bytes > encodedBytes) {
      closeRun();
    }
    if (recordRun.length === 0) {
      runStart = index;
    }
    recordRun.push(record);
    if (record.type === "decision") {
      run.push(record.decision);
    }
    runBytes += bytes;
  }
  closeRun();
  return parts;
};

/** A page's records as admitted parts, applied one after another. */
export const admitPageDecisions = (
  decisions: readonly IngestionResult[],
): AdmittedDecisions[] =>
  admitParts(decisions.map((decision) => ({ type: "decision", decision }))).map(
    ({ admitted }) => admitted,
  );

const boundsError = (
  reason: CaseLawBatchBoundsReason,
  message: string,
  index: number | null = null,
): Result<never, CaseLawBatchBoundsError> =>
  Result.err(new CaseLawBatchBoundsError({ message, reason, index }));

type PrepareCaseLawIngestionBatchOptions =
  | { decisions: readonly IngestionResult[]; records?: never }
  | { records: readonly CaseLawIngestionBatchRecord[]; decisions?: never };

/**
 * Admit records into one batch, or refuse them before any write: at least
 * one record, at most the record bound, no record over the byte bound, and
 * at most the byte bound in all.
 */
export const prepareCaseLawIngestionBatch = ({
  decisions,
  records: inputRecords,
}: PrepareCaseLawIngestionBatchOptions): Result<
  BoundedCaseLawIngestionBatch,
  CaseLawBatchBoundsError
> => {
  const inputBatchRecords =
    inputRecords ??
    decisions.map((decision) => ({ type: "decision" as const, decision }));
  const { records, encodedBytes } = CASE_LAW_INGESTION_BATCH_LIMITS;
  if (inputBatchRecords.length === 0) {
    return boundsError(
      CASE_LAW_BATCH_BOUNDS_REASON.EMPTY,
      "A batch holds at least one record",
    );
  }
  if (inputBatchRecords.length > records) {
    return boundsError(
      CASE_LAW_BATCH_BOUNDS_REASON.TOO_MANY_RECORDS,
      `A batch holds at most ${records} records, not ${inputBatchRecords.length}`,
    );
  }
  const batchRecords: CaseLawIngestionBatchRecord[] = [];
  for (const [index, record] of inputBatchRecords.entries()) {
    if (record.type === "decision") {
      if (!isValidRecordIdentity(record.recordIdentity)) {
        return boundsError(
          CASE_LAW_BATCH_BOUNDS_REASON.INVALID_RECORD,
          `Record ${index} has an invalid record identity`,
          index,
        );
      }
      batchRecords.push(record);
      continue;
    }
    if (!isValidRejectedRecord(record)) {
      return boundsError(
        CASE_LAW_BATCH_BOUNDS_REASON.INVALID_RECORD,
        `Rejected record ${index} must use text fields`,
        index,
      );
    }
    batchRecords.push({
      type: "rejected",
      recordKey: record.recordKey,
      recordHash: record.recordHash,
      language: record.language,
      ...(record.primaryLabel === undefined
        ? {}
        : { primaryLabel: record.primaryLabel }),
      reason: record.reason,
      message: record.message,
      ...(record.recordIdentity === undefined
        ? {}
        : { recordIdentity: record.recordIdentity }),
    });
  }
  const parts = admitParts(batchRecords);
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
