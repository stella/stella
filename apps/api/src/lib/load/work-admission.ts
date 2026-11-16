// parser-output-unchanged: failure grades and fingerprint dimensions preserve admitted work, error payloads and parser results.
import { panic, Result, TaggedError, UnhandledException } from "better-result";

import {
  declareFailureClass,
  declareFingerprintFields,
  type FailureReason,
} from "@stll/errors";
import { Temporal } from "@stll/time";

import { LIMITS } from "@/api/lib/limits";
import { createMemoryPressureGate } from "@/api/lib/memory-pressure";
import { logger } from "@/api/lib/observability/logger";
import { readProcessMemoryLimit } from "@/api/lib/observability/process-memory-limit";

import { createWorkBudget, type WorkBudget } from "./work-budget";
import { WORK_POOL_LIMITS, type WorkPool } from "./work-pools";

const ADMITTED = Symbol("work-admission");
type WorkHold = { status: "held" | "settled" };

const WORK_REFUSAL_REASON = {
  busy: "work_capacity_unavailable",
  memory: "work_capacity_unavailable",
  aborted: "work_cancelled",
} as const satisfies Record<WorkRefusal["reason"], FailureReason>;

export class WorkRefusal extends TaggedError("WorkRefusal")<{
  message: string;
  reason: "busy" | "memory" | "aborted";
  retryAfterMs: number;
}> {
  static {
    declareFailureClass(this, ({ reason }) => WORK_REFUSAL_REASON[reason]);
    declareFingerprintFields(this, ["reason"]);
  }
}

export class WorkDeadlineError extends TaggedError("WorkDeadlineError")<{
  message: string;
}> {}

export type WorkAdmission = {
  readonly pool: WorkPool;
  readonly kind: string;
  readonly signal: AbortSignal;
  readonly [ADMITTED]: WorkHold;
};

type PoolState = {
  budget: WorkBudget;
  refusedBusy: number;
  refusedMemory: number;
  deadlineCancelled: number;
};

type CreateWorkAdmissionOptions = {
  readRssBytes?: (() => number) | undefined;
};

type GeneratorResult =
  | Generator<unknown, unknown, unknown>
  | AsyncGenerator<unknown, unknown, unknown>;

/** Work settles inside `run`: a generator returned from it would run after the slot is released. */
export type AdmittedWork<T> = (
  admission: WorkAdmission,
) => Promise<T extends GeneratorResult ? never : T>;

export const createWorkAdmission = ({
  readRssBytes = () => process.memoryUsage.rss(),
}: CreateWorkAdmissionOptions = {}) => {
  const memoryLimit = readProcessMemoryLimit();
  const processMemoryBytes =
    memoryLimit.type === "limited"
      ? memoryLimit.bytes
      : LIMITS.fileDerivativeDeferRssFallbackBytes;
  const createPoolState = (pool: WorkPool): PoolState => {
    const limits = WORK_POOL_LIMITS[pool];
    const memoryGate = createMemoryPressureGate({
      holdMs: 0,
      now: () => Temporal.Now.instant().epochMilliseconds,
      readRssBytes,
      rssHighBytes: Math.floor(processMemoryBytes * limits.memoryCloseAt),
    });
    return {
      budget: createWorkBudget({
        slots: limits.slots,
        bytes: limits.bytes,
        maxWaiters: limits.maxWaiters,
        maxWaitMs: limits.maxWaitMs,
        memoryOpen: () => memoryGate.read().cause === null,
      }),
      refusedBusy: 0,
      refusedMemory: 0,
      deadlineCancelled: 0,
    };
  };
  const states = {
    "heavy-sidecar": createPoolState("heavy-sidecar"),
  } as const satisfies Record<WorkPool, PoolState>;

  type AcquireOptions = {
    pool: WorkPool;
    kind: string;
    bytes?: number | undefined;
    deadlineMs?: number | undefined;
    signal?: AbortSignal | undefined;
  };

  const acquire = async ({
    pool,
    kind,
    bytes = 0,
    deadlineMs,
    signal,
  }: AcquireOptions) => {
    const state = states[pool];
    const startedAt = Temporal.Now.instant().epochMilliseconds;
    const acquired = await state.budget.acquire({
      bytes,
      ...(signal === undefined ? {} : { signal }),
    });
    switch (acquired.type) {
      case "refused":
        if (acquired.reason === "memory") {
          state.refusedMemory += 1;
        } else if (acquired.reason === "busy") {
          state.refusedBusy += 1;
        }
        logger.warn("work.refused", {
          pool,
          kind,
          reason: acquired.reason,
          waitedMs: Math.max(
            0,
            Temporal.Now.instant().epochMilliseconds - startedAt,
          ),
          retryAfterMs: acquired.retryAfterMs,
          bytes,
        });
        return Result.err(
          new WorkRefusal({
            message: "Work capacity is unavailable",
            reason: acquired.reason,
            retryAfterMs: acquired.retryAfterMs,
          }),
        );
      case "admitted": {
        const deadline = Math.min(
          deadlineMs ?? WORK_POOL_LIMITS[pool].deadlineMs,
          WORK_POOL_LIMITS[pool].deadlineMs,
        );
        const deadlineController = new AbortController();
        const parent = signal ?? new AbortController().signal;
        const combined = AbortSignal.any([parent, deadlineController.signal]);
        const hold: WorkHold = { status: "held" };
        let settled = false;
        const settle = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          hold.status = "settled";
          acquired.release();
        };
        const timer = setTimeout(() => {
          state.deadlineCancelled += 1;
          deadlineController.abort(
            new WorkDeadlineError({ message: "Work deadline expired" }),
          );
        }, deadline);
        return Result.ok({
          admission: { pool, kind, signal: combined, [ADMITTED]: hold },
          settle,
        });
      }
      default:
        acquired satisfies never;
        return panic("Unhandled work budget result");
    }
  };

  const admit = async <T>({
    run,
    ...options
  }: AcquireOptions & { run: AdmittedWork<T> }): Promise<
    Result<T, WorkRefusal | UnhandledException>
  > => {
    const acquired = await acquire(options);
    if (Result.isError(acquired)) {
      return acquired;
    }
    const ran = await Result.tryPromise({
      try: async () => await run(acquired.value.admission),
      catch: (cause) => new UnhandledException({ cause }),
    });
    acquired.value.settle();
    return ran;
  };

  const poolMetrics = (pool: WorkPool) => {
    const state = states[pool];
    return {
      ...state.budget.stats(),
      refusedBusy: state.refusedBusy,
      refusedMemory: state.refusedMemory,
      deadlineCancelled: state.deadlineCancelled,
    };
  };

  return {
    admit,
    stats: () =>
      ({
        "heavy-sidecar": poolMetrics("heavy-sidecar"),
      }) as const satisfies Record<WorkPool, ReturnType<typeof poolMetrics>>,
  };
};

let processAdmission: ReturnType<typeof createWorkAdmission> | undefined;
const getWorkAdmission = () => {
  processAdmission ??= createWorkAdmission();
  return processAdmission;
};

export const admitWork: ReturnType<
  typeof createWorkAdmission
>["admit"] = async (options) => await getWorkAdmission().admit(options);
export const readWorkPoolMetrics = () => getWorkAdmission().stats();

export const resetWorkAdmissionForTesting = (): void => {
  const activePools = Object.values(getWorkAdmission().stats()).filter(
    ({ inFlight, queued }) => inFlight !== 0 || queued !== 0,
  );
  if (activePools.length > 0) {
    panic("Cannot reset work admission while work is active");
  }
  processAdmission = undefined;
};

export const assertWorkAdmission = (admission: WorkAdmission): void => {
  if (admission[ADMITTED].status === "settled") {
    panic("Work admission proof outlived its run");
  }
};
