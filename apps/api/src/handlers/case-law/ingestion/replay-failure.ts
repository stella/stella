import { TaggedError } from "better-result";

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
