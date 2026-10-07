import { panic, Result, TaggedError } from "better-result";
import { Worker } from "node:worker_threads";

import type { FailureReason } from "@stll/errors";
import { declareFailureClass } from "@stll/errors";
import type { SanctionsSource } from "@stll/sanctions";

import { detached } from "@/api/lib/analytics/capture";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  RUNTIME_WORKER_FILES,
  resolveRuntimeWorkerPath,
} from "@/api/lib/runtime-worker-path";

import type {
  SanctionsMatcherReply,
  SanctionsMatcherMessage,
  SanctionsMatcherRequest,
} from "./matcher-protocol";

export const SANCTIONS_MATCHER_CONFIG = {
  poolSize: 1,
  poolSizeMax: 2,
  deadlineMs: 250,
  warmupDeadlineMs: 10_000,
} as const;

const MATCHER_FAILURE_REASON = {
  "deadline-exceeded": "sanctions_matcher_deadline",
  "admission-refused": "sanctions_matcher_saturated",
  "pool-closed": "sanctions_matcher_closed",
  "worker-failed": "sanctions_matcher_failed",
  "operation-failed": "sanctions_matcher_failed",
} as const satisfies Record<string, FailureReason>;

export class SanctionsMatcherFailure extends TaggedError(
  "SanctionsMatcherFailure",
)<{
  code: keyof typeof MATCHER_FAILURE_REASON;
  message: string;
  cause?: unknown;
}> {
  static {
    declareFailureClass(this, ({ code }) => MATCHER_FAILURE_REASON[code]);
  }
}

const matcherFailure = (
  code: SanctionsMatcherFailure["code"],
  cause?: unknown,
) =>
  new SanctionsMatcherFailure({
    code,
    message: "Sanctions matcher could not complete its lease",
    cause,
  });

const MATCHER_FAILED_SINK = failureSink({
  event: "sanctions.matcher_failed",
  expected: [],
});

const reportMatcherFailure = (failure: SanctionsMatcherFailure) =>
  observeFailure(failure, {
    sink: MATCHER_FAILED_SINK,
    ctx: { feature: "sanctions.matcher", stage: failure.code },
  });

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
    return () => clearTimeout(timer);
  },
} satisfies MatcherDeadlineClock;

type MatcherPoolOptions = {
  size?: number;
  deadlineMs?: number;
  createWorker?: () => Worker;
  clock?: MatcherDeadlineClock;
};

type Slot = {
  worker: Worker | null;
  busy: boolean;
  editions: Map<SanctionsSource, string>;
  fail: ((failure: SanctionsMatcherFailure) => void) | null;
  termination: Promise<void> | null;
};

// Deadlines mutate this signal across awaits; do not reuse a narrowed property.
export const isSanctionsMatcherCancelled = (signal: AbortSignal): boolean =>
  signal.aborted;

const retireMatcherSlot = async (slot: Slot) => {
  const worker = slot.worker;
  slot.worker = null;
  slot.editions.clear();
  if (worker === null) {
    await (slot.termination ?? Promise.resolve());
    return;
  }
  slot.termination = worker.terminate().then(() => {
    slot.termination = null;
    return undefined;
  });
  await slot.termination;
};

type MatcherExitOptions = {
  slot: Slot;
  worker: Worker;
  notify: () => void;
  cause?: unknown;
};

const handleMatcherExit = ({
  slot,
  worker,
  notify,
  cause,
}: MatcherExitOptions) => {
  if (slot.worker !== worker) {
    return;
  }
  if (slot.fail !== null) {
    slot.fail(matcherFailure("worker-failed", cause));
    return;
  }
  reportMatcherFailure(matcherFailure("worker-failed", cause));
  slot.busy = true;
  detached(
    retireMatcherSlot(slot).then(() => {
      slot.busy = false;
      notify();
      return undefined;
    }),
    "sanctions.matcher-retire",
  );
};

type MatcherWorkOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "unavailable" };

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
  fail: (cause: unknown) => void;
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
      fail(sent.error);
    }
  });
};

type MatchSanctionsRequestOptions = {
  worker: Worker;
  signal: AbortSignal;
  request: SanctionsMatcherRequest;
  fail: (cause: unknown) => void;
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

/** Ephemeral, reconstructible indexes; each lease owns a worker for the entire request. */
export const createSanctionsMatcherPool = ({
  size = SANCTIONS_MATCHER_CONFIG.poolSize,
  deadlineMs = SANCTIONS_MATCHER_CONFIG.deadlineMs,
  createWorker = createMatcherWorker,
  clock = matcherDeadlineClock,
}: MatcherPoolOptions = {}) => {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > SANCTIONS_MATCHER_CONFIG.poolSizeMax ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0
  ) {
    panic("Invalid sanctions matcher pool configuration");
  }
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
    ): Promise<T | null> => {
      const controller = new AbortController();
      const failed = Promise.withResolvers<null>();
      // Written inside `work` and `fail`, read in `finally`: a holder, so
      // the checker does not pin either to its initial `null` across closures.
      const lease: { slot: Slot | null; retirement: Promise<void> | null } = {
        slot: null,
        retirement: null,
      };
      const fail = (failure: SanctionsMatcherFailure) => {
        if (isSanctionsMatcherCancelled(controller.signal)) {
          return;
        }
        reportMatcherFailure(failure);
        controller.abort();
        if (lease.slot !== null && lease.retirement === null) {
          lease.retirement = retireMatcherSlot(lease.slot);
        }
        failed.resolve(null);
      };
      const durationMs = options?.deadlineMs ?? deadlineMs;
      const expiresAt = clock.now() + durationMs;
      const cancelDeadline = clock.schedule(
        () => fail(matcherFailure("deadline-exceeded")),
        durationMs,
      );
      const work = async (): Promise<MatcherWorkOutcome<T>> => {
        lease.slot = await acquire(controller.signal);
        if (
          lease.slot === null ||
          isSanctionsMatcherCancelled(controller.signal)
        ) {
          fail(matcherFailure(closed ? "pool-closed" : "admission-refused"));
          return { status: "unavailable" };
        }
        const slot = lease.slot;
        slot.fail = fail;
        if (slot.worker === null) {
          const created = Result.try(createWorker);
          if (created.isErr()) {
            fail(matcherFailure("worker-failed", created.error));
            return { status: "unavailable" };
          }
          const worker = created.value;
          slot.worker = worker;
          worker.on("error", (cause) =>
            handleMatcherExit({ slot, worker, notify, cause }),
          );
          worker.on("exit", () => handleMatcherExit({ slot, worker, notify }));
          // An idle cache must not prevent shutdown of tests or the API.
          worker.unref();
        }
        const worker = slot.worker;
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
              fail: (cause) => fail(matcherFailure("worker-failed", cause)),
            });
            if (
              !isSanctionsMatcherCancelled(controller.signal) &&
              (response.status === "screened" || request.list !== null)
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
          fail(matcherFailure("operation-failed", result.error));
          return { status: "unavailable" };
        }
        if (clock.now() >= expiresAt) {
          fail(matcherFailure("deadline-exceeded"));
          return { status: "unavailable" };
        }
        return { status: "completed", value: result.value };
      };
      const pendingWork = work().finally(options?.onSettled);
      try {
        const outcome = await Promise.race([pendingWork, failed.promise]);
        return outcome === null || outcome.status === "unavailable"
          ? null
          : outcome.value;
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
        slot.fail?.(matcherFailure("pool-closed"));
      }
      notify();
      await Promise.all(slots.map(retireMatcherSlot));
    },
  };
};

// Lazy: no thread starts until an admitted public screening arrives.
export const sharedSanctionsMatcherPool = createSanctionsMatcherPool();
