import { panic, Result } from "better-result";
import { Worker } from "node:worker_threads";

import { createDetached } from "@stll/errors";
import type { SanctionsSource } from "@stll/sanctions";

import {
  RUNTIME_WORKER_FILES,
  resolveRuntimeWorkerPath,
} from "@/api/lib/runtime-worker-path";

import type {
  SanctionsMatcherReply,
  SanctionsMatcherMessage,
  SanctionsMatcherRequest,
} from "./matcher-protocol";
import type {
  reportSanctionsScreeningFailure,
  SanctionsMatcherFailureCause,
} from "./screening-failure";

export const SANCTIONS_MATCHER_CONFIG = {
  poolSize: 1,
  poolSizeMax: 2,
  deadlineMs: 250,
  warmupDeadlineMs: 10_000,
} as const;

export type SanctionsMatcherSession = {
  signal: AbortSignal;
  hasEdition: (source: SanctionsSource, editionId: string) => boolean;
  match: (request: SanctionsMatcherRequest) => Promise<SanctionsMatcherReply>;
};

type MatcherDeadlineClock = {
  now: () => number;
  schedule: (expire: () => void, durationMs: number) => () => void;
};

const matcherDeadlineClock = {
  now: () => performance.now(),
  schedule: (expire, durationMs) => {
    const timer = setTimeout(expire, durationMs);
    return () => {
      clearTimeout(timer);
    };
  },
} satisfies MatcherDeadlineClock;

export type MatcherPoolOptions = {
  size?: number;
  deadlineMs?: number;
  createWorker?: () => Worker;
  clock?: MatcherDeadlineClock;
  reportFailure: typeof reportSanctionsScreeningFailure;
};

type Slot = {
  worker: Worker | null;
  busy: boolean;
  editions: Map<SanctionsSource, string>;
  fail: ((cause: SanctionsMatcherFailureCause, error?: unknown) => void) | null;
  termination: Promise<void> | null;
};

// Deadlines mutate this signal across awaits; do not reuse a narrowed property.
export const isSanctionsMatcherCancelled = (signal: AbortSignal): boolean =>
  signal.aborted;

const retireMatcherSlot = async (
  slot: Slot,
  reportFailure: typeof reportSanctionsScreeningFailure,
) => {
  const worker = slot.worker;
  slot.worker = null;
  slot.editions.clear();
  if (worker === null) {
    await (slot.termination ?? Promise.resolve());
    return;
  }
  slot.termination = Result.tryPromise(
    async () => await worker.terminate(),
  ).then((result) => {
    if (result.isErr()) {
      reportFailure({
        stage: "matcher-pool",
        reason: "worker-retire",
        error: result.error,
      });
    }
    slot.termination = null;
    return undefined;
  });
  await slot.termination;
};

type MatcherExitOptions = {
  slot: Slot;
  worker: Worker;
  notify: () => void;
  reason: "worker-error" | "worker-exit";
  error?: unknown;
  reportFailure: typeof reportSanctionsScreeningFailure;
  detached: ReturnType<typeof createDetached>;
};

const handleMatcherExit = ({
  slot,
  worker,
  notify,
  reason,
  error,
  reportFailure,
  detached,
}: MatcherExitOptions) => {
  if (slot.worker !== worker) {
    return;
  }
  if (slot.fail !== null) {
    slot.fail(reason, error);
    return;
  }
  reportFailure({ stage: "matcher-pool", reason, error });
  slot.busy = true;
  detached(
    retireMatcherSlot(slot, reportFailure).then(() => {
      slot.busy = false;
      notify();
      return undefined;
    }),
    "sanctions.matcher-retire",
  );
};

type MatcherUnavailable = {
  status: "unavailable";
  cause: SanctionsMatcherFailureCause;
  error?: unknown;
};

export type MatcherWorkOutcome<T> =
  | { status: "completed"; value: T }
  | MatcherUnavailable;

const createMatcherWorker = () =>
  new Worker(
    resolveRuntimeWorkerPath({
      outputFile: RUNTIME_WORKER_FILES.sanctionsMatcher,
      sourceDir: import.meta.dir,
      sourceFile: "sanctions-matcher-worker.ts",
    }),
  );

const MATCHER_TRANSFER_ENTRIES = 1000;

type ExchangeMatcherMessageOptions = {
  worker: Worker;
  signal: AbortSignal;
  message: SanctionsMatcherMessage;
  fail: (cause: SanctionsMatcherFailureCause, error?: unknown) => void;
};

const exchangeMatcherMessage = async ({
  worker,
  signal,
  message,
  fail,
}: ExchangeMatcherMessageOptions): Promise<SanctionsMatcherReply> => {
  if (signal.aborted) {
    return { status: "unavailable" };
  }
  return await new Promise((resolve) => {
    const listeners = {
      abort: () => {
        worker.off("message", listeners.reply);
        resolve({ status: "unavailable" });
      },
      reply: (response: SanctionsMatcherReply) => {
        signal.removeEventListener("abort", listeners.abort);
        resolve(response);
      },
    };
    signal.addEventListener("abort", listeners.abort, { once: true });
    worker.once("message", listeners.reply);
    const sent = Result.try(() => worker.postMessage(message, []));
    if (sent.isErr()) {
      fail("worker-send", sent.error);
    }
  });
};

type MatchSanctionsRequestOptions = {
  worker: Worker;
  signal: AbortSignal;
  request: SanctionsMatcherRequest;
  fail: (cause: SanctionsMatcherFailureCause, error?: unknown) => void;
};

const matchSanctionsRequest = async ({
  worker,
  signal,
  request,
  fail,
}: MatchSanctionsRequestOptions): Promise<SanctionsMatcherReply> => {
  const exchange = async (message: SanctionsMatcherMessage) =>
    await exchangeMatcherMessage({
      worker,
      signal,
      message,
      fail,
    });
  if (request.list !== null) {
    for (
      let offset = 0;
      offset < request.list.entries.length;
      offset += MATCHER_TRANSFER_ENTRIES
    ) {
      const response = await exchange({
        type: "entries",
        source: request.source,
        editionId: request.editionId,
        offset,
        entries: request.list.entries.slice(
          offset,
          offset + MATCHER_TRANSFER_ENTRIES,
        ),
      });
      if (response.status !== "entries-loaded") {
        return { status: "unavailable" };
      }
    }
  }
  return await exchange({
    type: "screen",
    source: request.source,
    editionId: request.editionId,
    version: request.list?.version ?? null,
    query: request.query,
    cutoff: request.cutoff,
    limit: request.limit,
  });
};

type EnsureMatcherWorkerOptions = {
  slot: Slot;
  createWorker: () => Worker;
  notify: () => void;
  reportFailure: typeof reportSanctionsScreeningFailure;
  detached: ReturnType<typeof createDetached>;
  fail: NonNullable<Slot["fail"]>;
};

/** Install lifecycle listeners before admitting operations to one worker. */
const ensureMatcherWorker = ({
  slot,
  createWorker,
  notify,
  reportFailure,
  detached,
  fail,
}: EnsureMatcherWorkerOptions): Worker | null => {
  if (slot.worker !== null) {
    return slot.worker;
  }
  const created = Result.try(createWorker);
  if (created.isErr()) {
    fail("worker-create", created.error);
    return null;
  }
  const worker = created.value;
  slot.worker = worker;
  worker.on("error", (error) => {
    handleMatcherExit({
      slot,
      worker,
      notify,
      reason: "worker-error",
      error,
      reportFailure,
      detached,
    });
  });
  worker.on("exit", () => {
    handleMatcherExit({
      slot,
      worker,
      notify,
      reason: "worker-exit",
      reportFailure,
      detached,
    });
  });
  // An idle cache must not keep tests or the API process alive.
  worker.unref();
  return worker;
};

/** Ephemeral, reconstructible indexes; each lease owns a worker for the entire request. */
export const createSanctionsMatcherPoolCore = ({
  size = SANCTIONS_MATCHER_CONFIG.poolSize,
  deadlineMs = SANCTIONS_MATCHER_CONFIG.deadlineMs,
  createWorker = createMatcherWorker,
  clock = matcherDeadlineClock,
  reportFailure,
}: MatcherPoolOptions) => {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > SANCTIONS_MATCHER_CONFIG.poolSizeMax ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0
  ) {
    panic("Invalid sanctions matcher pool configuration");
  }
  const detached = createDetached((error) => {
    reportFailure({ stage: "matcher-pool", reason: "worker-retire", error });
  });
  const slots: Slot[] = Array.from({ length: size }, () => ({
    worker: null,
    busy: false,
    editions: new Map(),
    fail: null,
    termination: null,
  }));
  const waiters = new Set<() => void>();
  let closed = false;
  const notify = () => {
    for (const wake of waiters) {
      wake();
    }
  };
  const acquire = async (signal: AbortSignal): Promise<Slot | null> => {
    if (closed || signal.aborted) {
      return null;
    }
    // A warmup may use a second slot while a canceled acquisition still holds
    // the first. Prefer a populated idle worker so its next request stays warm.
    const slot = slots
      .filter((candidate) => !candidate.busy)
      .toSorted((a, b) => b.editions.size - a.editions.size)
      .at(0);
    if (slot !== undefined) {
      slot.busy = true;
      return slot;
    }
    // Public admission caps callers at two; refuse unbounded internal queues too.
    if (waiters.size >= SANCTIONS_MATCHER_CONFIG.poolSizeMax) {
      return null;
    }
    await new Promise<void>((resolve) => {
      const wake = () => {
        waiters.delete(wake);
        signal.removeEventListener("abort", wake);
        resolve();
      };
      waiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
    return await acquire(signal);
  };
  return {
    run: async <T>(
      operation: (session: SanctionsMatcherSession) => Promise<T>,
      options?: { deadlineMs?: number; onSettled?: () => void },
    ): Promise<MatcherWorkOutcome<T>> => {
      const controller = new AbortController();
      const failed = Promise.withResolvers<MatcherWorkOutcome<T>>();
      const failure: { outcome: MatcherUnavailable | null } = { outcome: null };
      // Written inside `work` and `fail`, read in `finally`: a holder, so
      // the checker does not pin either to its initial `null` across closures.
      const lease: { slot: Slot | null; retirement: Promise<void> | null } = {
        slot: null,
        retirement: null,
      };
      const fail = (cause: SanctionsMatcherFailureCause, error?: unknown) => {
        if (failure.outcome !== null) {
          return failure.outcome;
        }
        const outcome = {
          status: "unavailable",
          cause,
          ...(error === undefined ? {} : { error }),
        } as const satisfies MatcherUnavailable;
        failure.outcome = outcome;
        reportFailure({ stage: "matcher-pool", reason: cause, error });
        controller.abort();
        if (lease.slot !== null && lease.retirement === null) {
          lease.retirement = retireMatcherSlot(lease.slot, reportFailure);
        }
        failed.resolve(outcome);
        return outcome;
      };
      const durationMs = options?.deadlineMs ?? deadlineMs;
      const expiresAt = clock.now() + durationMs;
      const cancelDeadline = clock.schedule(() => {
        fail("deadline");
      }, durationMs);
      const work = async (): Promise<MatcherWorkOutcome<T>> => {
        lease.slot = await acquire(controller.signal);
        if (
          lease.slot === null ||
          isSanctionsMatcherCancelled(controller.signal)
        ) {
          return failure.outcome ?? fail(closed ? "closed" : "admission");
        }
        const slot = lease.slot;
        slot.fail = fail;
        const worker = ensureMatcherWorker({
          slot,
          createWorker,
          notify,
          reportFailure,
          detached,
          fail,
        });
        if (worker === null) {
          return fail("worker-create");
        }
        const session: SanctionsMatcherSession = {
          signal: controller.signal,
          hasEdition: (source, editionId) =>
            slot.editions.get(source) === editionId,
          match: async (request) => {
            if (isSanctionsMatcherCancelled(controller.signal)) {
              return { status: "unavailable" };
            }
            const response = await matchSanctionsRequest({
              worker,
              signal: controller.signal,
              request,
              fail,
            });
            if (
              response.status !== "screened" &&
              response.status !== "work-limit" &&
              !isSanctionsMatcherCancelled(controller.signal)
            ) {
              fail("worker-reply");
            }
            if (
              !isSanctionsMatcherCancelled(controller.signal) &&
              (response.status === "screened" ||
                response.status === "work-limit")
            ) {
              slot.editions.set(request.source, request.editionId);
            }
            return response;
          },
        };
        const result = await Result.tryPromise(
          async () => await operation(session),
        );
        if (result.isErr()) {
          return fail("operation", result.error);
        }
        if (clock.now() >= expiresAt) {
          return fail("deadline");
        }
        return { status: "completed", value: result.value };
      };
      // The caller deadline may finish first; lifecycle ownership ends with work.
      const pendingWork = work().finally(options?.onSettled);
      try {
        const outcome = await Promise.race([pendingWork, failed.promise]);
        return outcome;
      } finally {
        cancelDeadline();
        controller.abort();
        if (lease.slot !== null) {
          const slot = lease.slot;
          slot.fail = null;
          // Admission owns unfinished acquisition/page reads too, even after
          // the caller deadline. Reuse only after both work and retirement settle.
          const release = () => {
            slot.busy = false;
            notify();
            return undefined;
          };
          detached(
            Promise.all([
              pendingWork.then(
                () => undefined,
                () => undefined,
              ),
              lease.retirement ?? Promise.resolve(),
            ]).then(release),
            "sanctions.matcher-retire",
          );
        }
      }
    },
    close: async () => {
      closed = true;
      for (const slot of slots) {
        slot.fail?.("closed");
      }
      notify();
      await Promise.all(
        slots.map(async (slot) => await retireMatcherSlot(slot, reportFailure)),
      );
    },
  };
};
