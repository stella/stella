import { TaggedError } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { getPgDriverErrorCode, getPgErrorCode } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

export const MAX_REPLAY_ROW_READMISSIONS = 3;

export const REPLAY_PREVIEW_FAILURE = {
  RETRY_EXHAUSTED: "preview-retry-exhausted",
} as const;

export type ReplayPreviewFailure =
  (typeof REPLAY_PREVIEW_FAILURE)[keyof typeof REPLAY_PREVIEW_FAILURE];

export const REPLAY_FAILURE_CODES = [
  "stored-raw-timeout",
  "stored-raw-too-large",
  "stored-raw-read",
  "adapter-exception",
  "writer-retryable",
  "receipt-write",
  "tick-deadline",
  "tick-cancelled",
  "unexpected",
] as const;

export type ReplayFailure = {
  code: (typeof REPLAY_FAILURE_CODES)[number];
  scope: "row" | "systemic";
  messageClass:
    | "timeout"
    | "payload-budget"
    | "read"
    | "adapter"
    | "write"
    | "receipt"
    | "deadline"
    | "cancelled"
    | "unexpected";
};

const failureScopes = {
  "stored-raw-timeout": "systemic",
  "stored-raw-too-large": "row",
  "stored-raw-read": "systemic",
  "adapter-exception": "row",
  "writer-retryable": "systemic",
  "receipt-write": "systemic",
  "tick-deadline": "systemic",
  "tick-cancelled": "systemic",
  unexpected: "systemic",
} as const satisfies Record<ReplayFailure["code"], ReplayFailure["scope"]>;

export class ReplayStageError extends TaggedError("ReplayStageError")<{
  message: string;
  failure: ReplayFailure;
  cause?: unknown;
}> {}

const failureClasses = {
  "stored-raw-timeout": "timeout",
  "stored-raw-too-large": "payload-budget",
  "stored-raw-read": "read",
  "adapter-exception": "adapter",
  "writer-retryable": "write",
  "receipt-write": "receipt",
  "tick-deadline": "deadline",
  "tick-cancelled": "cancelled",
  unexpected: "unexpected",
} as const satisfies Record<
  ReplayFailure["code"],
  ReplayFailure["messageClass"]
>;

export const replayFailure = (code: ReplayFailure["code"]): ReplayFailure => ({
  code,
  scope: failureScopes[code],
  messageClass: failureClasses[code],
});

/** Persist classes, never object keys, decision text or exception messages. */
export const classifyReplayFailure = (cause: unknown): ReplayFailure => {
  // Adapter re-parsing may read metadata: a driver failure is an outage,
  // even when the stage wrapper describes it as an adapter exception.
  if (
    getPgErrorCode(cause) !== undefined ||
    getPgDriverErrorCode(cause) !== undefined
  ) {
    return replayFailure("unexpected");
  }
  let current = cause;
  for (let depth = 0; depth < 6; depth++) {
    if (current instanceof ReplayStageError) {
      return current.failure;
    }
    if (!isRecord(current)) {
      break;
    }
    if (
      current["name"] === "S3ObjectBudgetError" ||
      current["_tag"] === "S3ObjectBudgetError"
    ) {
      return replayFailure("stored-raw-too-large");
    }
    if (
      current["name"] === "TimeoutError" ||
      current["_tag"] === "TimeoutError"
    ) {
      return replayFailure("stored-raw-timeout");
    }
    current = current["cause"];
  }
  return replayFailure("unexpected");
};

export const REPLAY_ROW_OUTCOME = {
  /** The replay applied a changed re-parsed payload. */
  APPLIED: "applied",
  /** Re-parsing reproduced the output; its input proof may still be recorded. */
  UNCHANGED: "unchanged",
  /** Dry run: the re-parse differs from what is stored. */
  WOULD_APPLY: "would-apply",
  /** The adapter could not rebuild a result from this payload. */
  REJECTED: "rejected",
  /** The row names a stored payload that object storage does not hold. */
  MISSING_PAYLOAD: "missing-payload",
  /** The pipeline reported a retryable failure; the walk holds here. */
  RETRYABLE: "retryable",
  /** The row held a document the re-parse says is not one; it is gone. */
  WITHDRAWN: "withdrawn",
  /** A corpus object outlived its delete, so the row kept its document. */
  WITHDRAW_INCOMPLETE: "withdraw-incomplete",
  /** Dry run: the row holds a document the re-parse says is not one. */
  WOULD_WITHDRAW: "would-withdraw",
} as const;

export type ReplayRowOutcome =
  (typeof REPLAY_ROW_OUTCOME)[keyof typeof REPLAY_ROW_OUTCOME];

export type BackgroundReplaySource = {
  id: SafeId<"caseLawSource">;
  adapterKey: AdapterKey;
  currentParserVersion: number;
  dailyBudget: number;
  mode: "enrolled" | "dry-run";
  rowsBehind: number;
};
