import { AsyncLocalStorage } from "node:async_hooks";

import { LIMITS } from "@/api/lib/limits";
import { requestStartedAtMs } from "@/api/lib/load/request-latency-budget";
import { createWorkBudget } from "@/api/lib/load/work-budget";

/**
 * The corpus search reads one API process has in flight at once.
 *
 * The search engine answers a single read in a fraction of a second, but a
 * burst of reads (an agent's several phrasings, each a few scan rounds, a
 * highlight round and an aggregation, beside other users' searches) arriving
 * together share its few cores: each runs several times slower, and reads
 * that would have answered one after another inside their caller's budget
 * all run past it together. Holding the reads beyond `slots` in a queue lets
 * the ones admitted run at full speed, so the burst finishes as a sequence
 * instead of failing as a crowd.
 *
 * The queue is ordered by when the request a read serves began, then by the
 * read's lane (an agent search's phrasing index), so the request that has
 * waited longest goes first and an agent search's first phrasing completes
 * before its last. A read waits no longer than its own timeout, itself
 * bounded by the request's latency budget; the wait counts against that
 * timeout, so admission never extends how long a caller can be held.
 *
 * Process-local by design: it shapes this process's own load on the engine
 * and holds no state another replica needs. Losing it on restart loses
 * nothing but the queue position of reads that are cancelled anyway.
 */

/** Lanes a request's reads are told apart by; later lanes share the last. */
const LANES = 8;

const searchLane = new AsyncLocalStorage<number>();

/**
 * Run `fn` with the corpus reads it makes queued as lane `lane` of its
 * request: lower lanes of the same request are admitted first.
 */
export const runInCorpusSearchLane = <T>(lane: number, fn: () => T): T =>
  searchLane.run(Math.min(Math.max(0, Math.trunc(lane)), LANES - 1), fn);

/**
 * Where a read queues: by its request's start, then by its lane. Two keys,
 * so a lane only orders reads of requests that began at the same instant.
 */
const admissionRank = (): readonly number[] => [
  requestStartedAtMs() ?? performance.now(),
  searchLane.getStore() ?? 0,
];

export type CorpusSearchAdmission =
  | { type: "admitted"; release: () => void; waitedMs: number }
  | {
      type: "refused";
      /**
       * `expired`: the read's own timeout ran out while it queued. `busy`:
       * the queue was already full. `aborted`: the caller cancelled it.
       */
      reason: "expired" | "busy" | "aborted";
      /** The timer's or the caller's abort reason; absent when busy. */
      cause?: unknown;
      waitedMs: number;
      queued: number;
    };

type CreateCorpusSearchAdmissionOptions = {
  slots: number;
  maxWaiters?: number | undefined;
};

export const createCorpusSearchAdmission = ({
  slots,
  maxWaiters = LIMITS.corpusIndexSearchQueueMax,
}: CreateCorpusSearchAdmissionOptions) => {
  const budget = createWorkBudget({
    slots,
    bytes: Number.POSITIVE_INFINITY,
    maxWaiters,
    // An outer bound only: each read's own timeout ends its wait sooner.
    maxWaitMs: LIMITS.corpusIndexSearchQueueMaxWaitMs,
  });

  /**
   * Wait for a slot until `waitLimit` fires (the read's own bounded timeout,
   * which the caller owns) or the caller cancels. An admitted read must call
   * `release` once its response has been read.
   */
  const acquire = async ({
    waitLimit,
    signal,
  }: {
    waitLimit: AbortSignal;
    signal?: AbortSignal | undefined;
  }): Promise<CorpusSearchAdmission> => {
    const startedAt = performance.now();
    const result = await budget.acquire({
      signal:
        signal === undefined ? waitLimit : AbortSignal.any([signal, waitLimit]),
      rank: admissionRank(),
    });
    const waitedMs = performance.now() - startedAt;
    if (result.type === "admitted") {
      return { type: "admitted", release: result.release, waitedMs };
    }
    const { queued } = budget.stats();
    if (result.reason !== "aborted") {
      return { type: "refused", reason: "busy", waitedMs, queued };
    }
    return signal?.aborted === true
      ? {
          type: "refused",
          reason: "aborted",
          cause: signal.reason,
          waitedMs,
          queued,
        }
      : {
          type: "refused",
          reason: "expired",
          cause: waitLimit.reason,
          waitedMs,
          queued,
        };
  };

  return { acquire, stats: budget.stats };
};

export type CorpusSearchAdmissionGate = ReturnType<
  typeof createCorpusSearchAdmission
>;
