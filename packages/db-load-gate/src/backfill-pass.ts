import { panic, Result, TaggedError } from "better-result";

import { Temporal } from "@stll/time";

export class BackfillHeldError extends TaggedError("BackfillHeldError")<{
  message: string;
  holdUntil: number | null;
  heldSince: number | null;
}> {}

type BackfillPassBatch<Value> = {
  done: boolean;
  sleepMs: number;
  value: Value;
};

type BackfillPassOptions<Value> = {
  step: () => Promise<BackfillPassBatch<Value>>;
  onBatch?: (batch: BackfillPassBatch<Value>) => void | Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  maxWaitMs?: number;
  holdPolicy?: "wait" | "propagate";
  log?: (record: BackfillWaitRecord) => void;
};

type BackfillWaitRecord = {
  action: "wait" | "paused";
  reason: "hold" | "retry";
  now: number;
  holdUntil: number | null;
  heldSince: number | null;
  sleepMs: number;
  waitedMs: number;
  maxWaitMs: number | null;
  message: string;
};

const RETRY_BACKOFF_MS = 1000;

/** Operator passes wait for durable holds; online repairs propagate them. */
export const runBackfillPass = async <Value>({
  step,
  onBatch,
  sleep,
  clock = () => Temporal.Now.instant().epochMilliseconds,
  maxWaitMs,
  holdPolicy = "wait",
  log = (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
}: BackfillPassOptions<Value>) => {
  if (
    maxWaitMs !== undefined &&
    (!Number.isFinite(maxWaitMs) || maxWaitMs < 0)
  ) {
    panic("Backfill maximum wait must be finite and nonnegative");
  }
  let waitedMs = 0;
  while (true) {
    const outcome = await Result.tryPromise({
      try: step,
      catch: (cause: unknown) => cause,
    });
    if (outcome.isErr()) {
      if (
        !(outcome.error instanceof BackfillHeldError) ||
        holdPolicy === "propagate"
      ) {
        return Result.err(outcome.error);
      }
      const now = clock();
      const { holdUntil, heldSince } = outcome.error;
      const sleepMs =
        holdUntil === null ? RETRY_BACKOFF_MS : Math.max(0, holdUntil - now);
      const record = {
        reason: holdUntil === null ? "retry" : "hold",
        now,
        holdUntil,
        heldSince,
        sleepMs,
        waitedMs,
        maxWaitMs: maxWaitMs ?? null,
        message: outcome.error.message,
      } as const;
      if (maxWaitMs !== undefined && waitedMs + sleepMs > maxWaitMs) {
        log({
          ...record,
          action: "paused",
          message: `${record.message}; rerun the same command to resume from its saved checkpoint`,
        });
        return Result.ok({ status: "paused" as const, holdUntil, waitedMs });
      }
      log({ ...record, action: "wait" });
      const waited = await Result.tryPromise({
        try: async () => await sleep(sleepMs),
        catch: (cause: unknown) => cause,
      });
      if (waited.isErr()) {
        return Result.err(waited.error);
      }
      waitedMs += Math.max(sleepMs, clock() - now);
      continue;
    }
    const batch = outcome.value;
    const observed = await Result.tryPromise({
      try: async () => await onBatch?.(batch),
      catch: (cause: unknown) => cause,
    });
    if (observed.isErr()) {
      return Result.err(observed.error);
    }
    if (batch.done) {
      return Result.ok({ status: "complete" as const });
    }
    if (batch.sleepMs > 0) {
      const paced = await Result.tryPromise({
        try: async () => await sleep(batch.sleepMs),
        catch: (cause: unknown) => cause,
      });
      if (paced.isErr()) {
        return Result.err(paced.error);
      }
    }
  }
};
