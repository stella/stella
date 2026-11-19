import { panic, Result, TaggedError } from "better-result";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { Temporal } from "@stll/time";

export class BackfillHeldError extends TaggedError("BackfillHeldError")<{
  message: string;
  holdUntil: number | null;
  heldSince: number | null;
}> {}

/** A batch failed; a persisted hold or retry adjustment does not undo its failure. */
export class BackfillFailedError extends TaggedError("BackfillFailedError")<{
  message: string;
  cause: unknown;
  holdUntil: number | null;
  heldSince: number | null;
}> {}

/**
 * A batch lost a lock wait (its lock timeout, or a deadlock) and rolled back
 * whole: another transaction held a lock it needs. Nothing moved, so the
 * same batch runs again once the holder lets go.
 */
export class BackfillLockWaitError extends TaggedError(
  "BackfillLockWaitError",
)<{
  message: string;
  /** The relation the batch waited on, when PostgreSQL named it. */
  relation: string | null;
  cause: unknown;
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
  /**
   * How long batches may keep losing lock waits in a row before the pass
   * stops with the `BackfillLockWaitError`; a committed batch starts it over.
   */
  maxLockWaitMs?: number;
  holdPolicy?: "wait" | "propagate";
  log?: (record: BackfillWaitRecord) => void;
};

export type BackfillWaitRecord =
  | {
      action: "wait" | "paused";
      reason: "hold" | "retry";
      now: number;
      holdUntil: number | null;
      heldSince: number | null;
      sleepMs: number;
      waitedMs: number;
      maxWaitMs: number | null;
      message: string;
    }
  | {
      action: "wait" | "stopped";
      reason: "lock_wait";
      now: number;
      relation: string | null;
      sleepMs: number;
      /** Since the first lock wait of this run of them. */
      waitedMs: number;
      maxLockWaitMs: number;
      message: string;
    };

const RETRY_BACKOFF_MS = 1000;
/** The first pause after a lost lock wait; each further one doubles. */
const LOCK_WAIT_BACKOFF_BASE_MS = 1000;
const LOCK_WAIT_BACKOFF_CAP_MS = 30_000;
/** How long a pass keeps retrying lost lock waits when its caller sets no bound. */
export const DEFAULT_BACKFILL_MAX_LOCK_WAIT_MS = 5 * 60_000;

/** The pass's default wait log: one JSON line per record on stderr. */
export const logBackfillWait = (record: BackfillWaitRecord) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/** Lost lock waits in a row, and when the first of them was met. */
type LockWaitRun = { count: number; since: number | null };

/**
 * Back off once after a lost lock wait, doubling with each loss in a row, or
 * refuse with the wait itself once the next pause would pass `maxLockWaitMs`.
 */
const waitOutLockWait = async ({
  error,
  lockWaits,
  now,
  maxLockWaitMs,
  sleep,
  log,
}: {
  error: BackfillLockWaitError;
  lockWaits: LockWaitRun;
  now: number;
  maxLockWaitMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  log: (record: BackfillWaitRecord) => void;
}): Promise<Result<void, unknown>> => {
  lockWaits.since ??= now;
  const sleepMs = backoffDelay(Math.min(lockWaits.count, 30), {
    baseMs: LOCK_WAIT_BACKOFF_BASE_MS,
    maxMs: LOCK_WAIT_BACKOFF_CAP_MS,
  });
  lockWaits.count += 1;
  const waitedMs = now - lockWaits.since;
  const record = {
    reason: "lock_wait",
    now,
    relation: error.relation,
    sleepMs,
    waitedMs,
    maxLockWaitMs,
    message: error.message,
  } as const;
  if (waitedMs + sleepMs > maxLockWaitMs) {
    log({ ...record, action: "stopped" });
    return Result.err(error);
  }
  log({ ...record, action: "wait" });
  return await Result.tryPromise({
    try: async () => await sleep(sleepMs),
    catch: (cause: unknown) => cause,
  });
};

/** Operator passes wait for durable holds; online repairs propagate them. */
export const runBackfillPass = async <Value>({
  step,
  onBatch,
  sleep,
  clock = () => Temporal.Now.instant().epochMilliseconds,
  maxWaitMs,
  maxLockWaitMs = DEFAULT_BACKFILL_MAX_LOCK_WAIT_MS,
  holdPolicy = "wait",
  log = logBackfillWait,
}: BackfillPassOptions<Value>) => {
  if (
    maxWaitMs !== undefined &&
    (!Number.isFinite(maxWaitMs) || maxWaitMs < 0)
  ) {
    panic("Backfill maximum wait must be finite and nonnegative");
  }
  if (!Number.isFinite(maxLockWaitMs) || maxLockWaitMs < 0) {
    panic("Backfill maximum lock wait must be finite and nonnegative");
  }
  let waitedMs = 0;
  const lockWaits: LockWaitRun = { count: 0, since: null };
  while (true) {
    const outcome = await Result.tryPromise({
      try: step,
      catch: (cause: unknown) => cause,
    });
    if (
      outcome.isErr() &&
      outcome.error instanceof BackfillLockWaitError &&
      holdPolicy === "wait"
    ) {
      const waited = await waitOutLockWait({
        error: outcome.error,
        lockWaits,
        now: clock(),
        maxLockWaitMs,
        sleep,
        log,
      });
      if (waited.isErr()) {
        return Result.err(waited.error);
      }
      continue;
    }
    if (outcome.isErr()) {
      if (
        !(
          outcome.error instanceof BackfillHeldError ||
          outcome.error instanceof BackfillFailedError
        ) ||
        holdPolicy === "propagate"
      ) {
        return Result.err(outcome.error);
      }
      const now = clock();
      const { holdUntil, heldSince } = outcome.error;
      const sleepMs =
        holdUntil === null ? RETRY_BACKOFF_MS : Math.max(0, holdUntil - now);
      const record = {
        reason:
          outcome.error instanceof BackfillFailedError || holdUntil === null
            ? "retry"
            : "hold",
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
    lockWaits.count = 0;
    lockWaits.since = null;
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
