import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  SourceRawParts,
  SourceRawObjects,
  StoredRawReadError,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { SkUsListingFetchOutcome } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import type { SafeId } from "@/api/lib/branded-types";
import {
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";

export type SkUsRawCursor = {
  createdAt: string;
  id: SafeId<"caseLawDecision">;
};

type SelectSkUsRawPageOptions = {
  sourceId: SafeId<"caseLawSource">;
  after: SkUsRawCursor | null;
  limit: number;
};

/** Project only columns covered by the source-generation cursor index. */
export const selectSkUsRawPageStatement = ({
  sourceId,
  after,
  limit,
}: SelectSkUsRawPageOptions) => sql`
  SELECT d.id, ${pgTimestampCursorValue(sql`d.created_at`)} AS created_at
  FROM case_law_decisions d
  WHERE d.source_id = ${sourceId}::uuid
  ${after === null ? sql`` : sql`AND (d.created_at, d.id) > (${pgTimestampCursorBoundary({ type: "pgTimestampCursor", value: after.createdAt, precision: "microseconds" })}, ${after.id}::uuid)`}
  ORDER BY d.created_at, d.id LIMIT ${limit}
`;

type CompleteSkUsRawOptions = {
  sourceId: SafeId<"caseLawSource">;
  id: SafeId<"caseLawDecision">;
  oldKey: string;
  newKey: string;
  oldContentType: string | null;
};

/** A concurrent publisher observation wins; the repair never changes its hash. */
export const completeSkUsRawStatement = ({
  sourceId,
  id,
  oldKey,
  newKey,
  oldContentType,
}: CompleteSkUsRawOptions) => sql`
  UPDATE case_law_decisions
  SET source_raw_s3_key = ${newKey}, source_raw_content_type = ${SOURCE_RAW_ENVELOPE_CONTENT_TYPE}
  WHERE id = ${id}::uuid AND source_id = ${sourceId}::uuid
    AND source_raw_s3_key = ${oldKey}
    AND source_raw_content_type IS NOT DISTINCT FROM ${oldContentType}
    AND redacted_at IS NULL
  RETURNING id
`;

export const SK_US_RAW_OUTCOMES = [
  "already_complete",
  "completed",
  "would_complete",
  "listing_unavailable",
  "listing_identity_mismatch",
  "raw_unavailable",
  "raw_read_rejected",
  "publisher_rate_limited",
  "retry_later",
  "concurrent_write",
] as const;
export type SkUsRawOutcome = (typeof SK_US_RAW_OUTCOMES)[number];

export const SK_US_RAW_OUTCOME_DISPOSITIONS = {
  already_complete: "terminal",
  completed: "terminal",
  would_complete: "preview",
  listing_unavailable: "terminal",
  listing_identity_mismatch: "terminal",
  raw_unavailable: "terminal",
  raw_read_rejected: "terminal",
  publisher_rate_limited: "retryable",
  retry_later: "retryable",
  concurrent_write: "retryable",
} as const satisfies Record<
  SkUsRawOutcome,
  "terminal" | "retryable" | "preview"
>;

type SkUsRawInput = {
  raw: Uint8Array;
  contentType: string | null;
  documentId: string;
  caseNumber: string;
};

type SkUsRawCompletion = {
  parts: SourceRawParts;
  objects: SourceRawObjects;
  /** A legacy PDF remains bytes, never a lossy UTF-8 string. */
  file: Uint8Array | null;
};

type PrepareSkUsRawOptions = SkUsRawInput & {
  fetchListing: (identity: {
    documentId: string;
    caseNumber: string;
  }) => Promise<SkUsListingFetchOutcome>;
};

export const prepareSkUsRawCompletion = async ({
  raw,
  contentType,
  documentId,
  caseNumber,
  fetchListing,
}: PrepareSkUsRawOptions): Promise<
  | { type: "prepared"; completion: SkUsRawCompletion }
  | {
      type:
        | "already_complete"
        | "raw_unavailable"
        | "listing_unavailable"
        | "listing_identity_mismatch"
        | "publisher_rate_limited"
        | "retry_later";
    }
> => {
  let parts: SourceRawParts;
  let objects: SourceRawObjects = {};
  let file: Uint8Array | null = null;
  if (contentType === "application/pdf") {
    parts = {};
    file = raw;
  } else {
    // Undecodable bytes never change on a later read: terminal, not a retry.
    const decoded = Result.try(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    if (Result.isError(decoded)) {
      return { type: "raw_unavailable" };
    }
    const text = decoded.value;
    const envelope = decodeSourceRawEnvelope(text);
    if (envelope === null) {
      return { type: "raw_unavailable" };
    }
    if (envelope["listing"] !== undefined) {
      return { type: "already_complete" };
    }
    parts = envelope;
    const refs = decodeSourceRawEnvelopeObjects(text);
    objects = refs;
  }
  const fetched = await fetchListing({ documentId, caseNumber });
  switch (fetched.type) {
    case "listing":
      return {
        type: "prepared",
        completion: {
          parts: { ...parts, listing: fetched.listing },
          objects,
          file,
        },
      };
    case "listing_unavailable":
    case "listing_identity_mismatch":
    case "publisher_rate_limited":
    case "retry_later":
      return { type: fetched.type };
    default:
      fetched satisfies never;
      return panic("Unknown listing outcome");
  }
};

/** A byte-stable envelope over the old parts and binary references. */
export const completedSkUsRawEnvelope = ({
  parts,
  objects,
}: SkUsRawCompletion) => encodeSourceRawEnvelope(parts, objects);

type CompleteSkUsRawObservationOptions = Omit<PrepareSkUsRawOptions, "raw"> & {
  raw: Result<Uint8Array | null, StoredRawReadError>;
  mode: "apply" | "dry-run";
  writeCompletion: (
    completion: SkUsRawCompletion,
  ) => Promise<"completed" | "concurrent_write" | "retry_later">;
};

/** Both command modes make the same decision; only apply can reach storage. */
export const completeSkUsRawObservation = async ({
  mode,
  raw,
  writeCompletion,
  ...input
}: CompleteSkUsRawObservationOptions): Promise<SkUsRawOutcome> => {
  if (Result.isError(raw)) {
    return raw.error.permanent ? "raw_read_rejected" : "retry_later";
  }
  if (raw.value === null) {
    return "raw_unavailable";
  }
  const prepared = await prepareSkUsRawCompletion({ ...input, raw: raw.value });
  if (prepared.type !== "prepared") {
    return prepared.type;
  }
  if (mode === "dry-run") {
    return "would_complete";
  }
  return await writeCompletion(prepared.completion);
};

type RunSkUsRawPageOptions = {
  rows: readonly SkUsRawCursor[];
  mode: "apply" | "dry-run";
  complete: (
    row: SkUsRawCursor,
    mode: "apply" | "dry-run",
  ) => Promise<SkUsRawOutcome>;
  /**
   * Every attempted row in both modes, before its journal record: the
   * operator's per-row evidence, which outlives the task's local files.
   */
  record: (cursor: SkUsRawCursor, outcome: SkUsRawOutcome) => void;
  journal: (cursor: SkUsRawCursor, outcome: SkUsRawOutcome) => Promise<void>;
  checkpoint: (cursor: SkUsRawCursor, outcome: SkUsRawOutcome) => Promise<void>;
};

/** Retryable or ambiguous work holds the cursor; a crash replays its last item. */
export const runSkUsRawPage = async ({
  rows,
  mode,
  complete,
  record,
  journal,
  checkpoint,
}: RunSkUsRawPageOptions) => {
  const counts = Object.fromEntries(
    SK_US_RAW_OUTCOMES.map((outcome) => [outcome, 0]),
  );
  let cursor: SkUsRawCursor | null = null;
  for (const row of rows) {
    const outcome = await complete(row, mode);
    const count = counts[outcome];
    if (count === undefined) {
      panic(`Unknown completion outcome: ${outcome}`);
    }
    counts[outcome] = count + 1;
    record(row, outcome);
    if (mode === "apply") {
      await journal(row, outcome);
    }
    if (SK_US_RAW_OUTCOME_DISPOSITIONS[outcome] === "retryable") {
      return { counts, cursor, stopped: true };
    }
    if (mode === "apply") {
      await checkpoint(row, outcome);
    }
    cursor = row;
  }
  return { counts, cursor, stopped: false };
};

type RunSkUsRawBatchOptions = RunSkUsRawPageOptions & {
  pageSize: number;
  after: SkUsRawCursor | null;
};

/** Consume one bounded selection; a stopped page prevents later pages running. */
export const runSkUsRawBatch = async ({
  rows,
  pageSize,
  after,
  ...options
}: RunSkUsRawBatchOptions) => {
  const counts: Record<string, number> = {};
  let scanned = 0;
  let cursor = after;
  let stopped = false;
  for (const itemBatch of chunkItems(rows, pageSize)) {
    const result = await runSkUsRawPage({
      ...options,
      rows: itemBatch,
    });
    for (const [outcome, count] of Object.entries(result.counts)) {
      counts[outcome] = (counts[outcome] ?? 0) + count;
      scanned += count;
    }
    cursor = result.cursor ?? cursor;
    if (result.stopped) {
      stopped = true;
      break;
    }
  }
  return { scanned, counts, cursor, stopped };
};
