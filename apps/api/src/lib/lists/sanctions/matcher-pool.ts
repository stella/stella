import { panic, Result } from "better-result";
import { Worker } from "node:worker_threads";

import type { SanctionsSource } from "@stll/sanctions";

import { detached } from "@/api/lib/analytics/capture";
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

export type SanctionsMatcherSession = {
  signal: AbortSignal;
  hasEdition: (source: SanctionsSource, editionId: string) => boolean;
  match: (request: SanctionsMatcherRequest) => Promise<SanctionsMatcherReply>;
};

type MatcherPoolOptions = {
  size?: number;
  deadlineMs?: number;
  createWorker?: () => Worker;
};

type Slot = {
  worker: Worker | null;
  busy: boolean;
  editions: Map<SanctionsSource, string>;
  fail: (() => void) | null;
  termination: Promise<void> | null;
};

const retireMatcherSlot = (slot: Slot) => {
  const worker = slot.worker;
  slot.worker = null;
  slot.editions.clear();
  if (worker === null) {
    return slot.termination ?? Promise.resolve();
  }
  slot.termination = worker.terminate().then(() => {
    slot.termination = null;
    return undefined;
  });
  return slot.termination;
};

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
  fail: () => void;
};

const exchangeMatcherMessage = ({
  worker,
  signal,
  message,
  fail,
}: ExchangeMatcherMessageOptions): Promise<SanctionsMatcherReply> => {
  if (signal.aborted) {
    return Promise.resolve({ status: "unavailable" });
  }
  return new Promise((resolve) => {
    const abort = () => {
      worker.off("message", reply);
      resolve({ status: "unavailable" });
    };
    const reply = (response: SanctionsMatcherReply) => {
      signal.removeEventListener("abort", abort);
      resolve(response);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", reply);
    const sent = Result.try(() => worker.postMessage(message, []));
    if (sent.isErr()) {
      fail();
    }
  });
};

type MatchSanctionsRequestOptions = {
  worker: Worker;
  signal: AbortSignal;
  request: SanctionsMatcherRequest;
  fail: () => void;
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
    const slot = slots.find((candidate) => !candidate.busy);
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
      const fail = () => {
        controller.abort();
        if (lease.slot !== null && lease.retirement === null) {
          lease.retirement = retireMatcherSlot(lease.slot);
        }
        failed.resolve(null);
      };
      const durationMs = options?.deadlineMs ?? deadlineMs;
      const expiresAt = performance.now() + durationMs;
      const timer = setTimeout(fail, durationMs);
      const work = async (): Promise<T | null> => {
        lease.slot = await acquire(controller.signal);
        if (lease.slot === null || controller.signal.aborted) {
          return null;
        }
        const slot = lease.slot;
        slot.fail = fail;
        if (slot.worker === null) {
          const created = Result.try(createWorker);
          if (created.isErr()) {
            fail();
            return null;
          }
          const worker = created.value;
          slot.worker = worker;
          worker.on("error", () => {
            if (slot.worker !== worker) {
              return;
            }
            if (slot.fail !== null) {
              slot.fail();
            } else {
              slot.busy = true;
              detached(
                retireMatcherSlot(slot).then(() => {
                  slot.busy = false;
                  notify();
                  return undefined;
                }),
                "sanctions.matcher-retire",
              );
            }
          });
          worker.on("exit", () => {
            if (slot.worker === worker) {
              if (slot.fail !== null) {
                slot.fail();
              } else {
                slot.busy = true;
                detached(
                  retireMatcherSlot(slot).then(() => {
                    slot.busy = false;
                    notify();
                    return undefined;
                  }),
                  "sanctions.matcher-retire",
                );
              }
            }
          });
          // An idle cache must not prevent shutdown of tests or the API.
          worker.unref();
        }
        const worker = slot.worker;
        const session: SanctionsMatcherSession = {
          signal: controller.signal,
          hasEdition: (source, editionId) =>
            slot.editions.get(source) === editionId,
          match: async (request) => {
            if (controller.signal.aborted) {
              return { status: "unavailable" };
            }
            const response = await matchSanctionsRequest({
              worker,
              signal: controller.signal,
              request,
              fail,
            });
            if (
              !controller.signal.aborted &&
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
        if (result.isErr() || performance.now() >= expiresAt) {
          fail();
          return null;
        }
        return result.value;
      };
      const pendingWork = work().finally(options?.onSettled);
      try {
        return await Promise.race([pendingWork, failed.promise]);
      } finally {
        clearTimeout(timer);
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
        slot.fail?.();
      }
      notify();
      await Promise.all(slots.map(retireMatcherSlot));
    },
  };
};

// Lazy: no thread starts until an admitted public screening arrives.
export const sharedSanctionsMatcherPool = createSanctionsMatcherPool();
