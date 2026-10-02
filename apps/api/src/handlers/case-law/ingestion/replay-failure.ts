import { TaggedError } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

export const REPLAY_FAILURE_CODES = [
  "stored-raw-timeout",
  "stored-raw-too-large",
  "stored-raw-read",
  "adapter-exception",
  "writer-retryable",
  "receipt-write",
  "tick-deadline",
  "unexpected",
] as const;

export type ReplayFailure = {
  code: (typeof REPLAY_FAILURE_CODES)[number];
  messageClass:
    | "timeout"
    | "payload-budget"
    | "read"
    | "adapter"
    | "write"
    | "receipt"
    | "deadline"
    | "unexpected";
};

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
  unexpected: "unexpected",
} as const satisfies Record<
  ReplayFailure["code"],
  ReplayFailure["messageClass"]
>;

export const replayFailure = (code: ReplayFailure["code"]): ReplayFailure => ({
  code,
  messageClass: failureClasses[code],
});

/** Persist classes, never object keys, decision text or exception messages. */
export const classifyReplayFailure = (cause: unknown): ReplayFailure => {
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
