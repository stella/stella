import { AsyncLocalStorage } from "node:async_hooks";

import { sleep } from "@stll/concurrency/sleep";

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
 * The queue is ordered by start-time fair queueing across callers, then by
 * when the request a read serves began, then by the read's lane (an agent
 * search's phrasing index). One caller's backlog is its own: however many reads
 * it queues, each other caller's next read goes ahead of the backlog's tail,
 * while within one caller the request that has waited longest goes first and an
 * agent search's first phrasing completes before its last. Reads without a
 * caller (public routes, background work) keep the plain request order. A read
 * waits no longer than its own timeout, itself bounded by the request's latency
 * budget; the wait counts against that timeout, so admission never extends how
 * long a caller can be held. A read the queue estimates it cannot start within
 * that time is told so at once, rather than waiting out its budget.
 *
 * Process-local by design: it shapes this process's own load on the engine
 * and holds no state another replica needs. Losing it on restart loses
 * nothing but the queue position of reads that are cancelled anyway.
 */

/** Lanes a request's reads are told apart by; later lanes share the last. */
const LANES = 8;

const searchLane = new AsyncLocalStorage<number>();
const searchCaller = new AsyncLocalStorage<string>();

const patientReads = new AsyncLocalStorage<true>();

/** How often a patient read looks again at a queue that was full. */
const FULL_QUEUE_RETRY_MS = 250;

/**
 * Run `fn` with its reads patient: nobody is waiting on them, so a full queue
 * or a long estimate is a reason to wait, not to fail. Only a run detached from
 * its request may be patient; its own timeout still bounds every read.
 */
export const runWithPatientCorpusReads = <T>(fn: () => T): T =>
  patientReads.run(true, fn);

/** Reads per caller a queue's fairness tracks; only backlogged callers count. */
type CallerFlow = {
  /** Virtual time this caller's next read starts at. */
  finish: number;
  queued: number;
};

/** The reads a queue needs before it trusts its estimate of a read's wait. */
const MIN_SERVICE_SAMPLES = 8;
/** Exponential moving average weight of the newest service time. */
const SERVICE_EWMA_WEIGHT = 0.2;

/**
 * Run `fn` with the corpus reads it makes queued as lane `lane` of its
 * request: lower lanes of the same request are admitted first.
 */
export const runInCorpusSearchLane = <T>(lane: number, fn: () => T): T =>
  searchLane.run(Math.min(Math.max(0, Math.trunc(lane)), LANES - 1), fn);

/**
 * Run `fn` with the corpus reads it makes attributed to `caller`, so one
 * caller's backlog cannot starve another's next read. Absent, a read queues by
 * request order alone.
 */
export const runAsCorpusSearchCaller = <T>(caller: string, fn: () => T): T =>
  searchCaller.run(caller, fn);

/**
 * Where a read queues: its caller's virtual start time, then its request's
 * start, then its lane. A lane only orders reads of requests that began at
 * the same instant; a start time only orders reads of one caller.
 */
const admissionRank = (virtualStart: number): readonly number[] => [
  virtualStart,
  requestStartedAtMs() ?? performance.now(),
  searchLane.getStore() ?? 0,
];

export type CorpusSearchAdmission =
  | { type: "admitted"; release: () => void; waitedMs: number }
  | {
      type: "refused";
      /**
       * `expired`: the read's own timeout ran out while it queued. `busy`:
       * the queue was already full. `deadline`: the queue's estimate says the
       * read cannot start within its own timeout. `aborted`: the caller
       * cancelled it.
       */
      reason: "expired" | "busy" | "deadline" | "aborted";
      /** The timer's or the caller's abort reason; absent when busy. */
      cause?: unknown;
      waitedMs: number;
      queued: number;
    };

type CreateCorpusSearchAdmissionOptions = {
  slots: number;
  maxWaiters?: number | undefined;
  now?: (() => number) | undefined;
};

export const createCorpusSearchAdmission = ({
  slots,
  maxWaiters = LIMITS.corpusIndexSearchQueueMax,
  now = () => performance.now(),
}: CreateCorpusSearchAdmissionOptions) => {
  const budget = createWorkBudget({
    slots,
    bytes: Number.POSITIVE_INFINITY,
    maxWaiters,
    // An outer bound only: each read's own timeout ends its wait sooner.
    maxWaitMs: LIMITS.corpusIndexSearchQueueMaxWaitMs,
  });
  // Start-time fair queueing: virtual time advances to the start of each read
  // admitted. A caller with no backlog starts now; a backlogged one after its
  // own previous read. Flows exist only while their caller has a read queued.
  const flows = new Map<string, CallerFlow>();
  let virtualNow = 0;
  let serviceMsEwma: number | undefined;
  let serviceSamples = 0;

  const recordServiceMs = (ms: number): void => {
    serviceMsEwma =
      serviceMsEwma === undefined
        ? ms
        : serviceMsEwma * (1 - SERVICE_EWMA_WEIGHT) + ms * SERVICE_EWMA_WEIGHT;
    serviceSamples += 1;
  };

  /**
   * How long a read arriving now would wait for a slot: the reads ahead of it
   * divided across the slots, each taking the average service time. Zero until
   * the queue has seen enough reads to say.
   */
  const estimatedWaitMs = (): number => {
    if (serviceMsEwma === undefined || serviceSamples < MIN_SERVICE_SAMPLES) {
      return 0;
    }
    const { queued } = budget.stats();
    return ((queued + 1) / slots) * serviceMsEwma;
  };

  const enterFlow = (caller: string | undefined): number => {
    if (caller === undefined) {
      return virtualNow;
    }
    const flow = flows.get(caller) ?? { finish: virtualNow, queued: 0 };
    const start = Math.max(virtualNow, flow.finish);
    flow.finish = start + 1;
    flow.queued += 1;
    flows.set(caller, flow);
    return start;
  };

  const leaveFlow = (caller: string | undefined): void => {
    if (caller === undefined) {
      return;
    }
    const flow = flows.get(caller);
    if (flow === undefined) {
      return;
    }
    flow.queued -= 1;
    if (flow.queued === 0) {
      flows.delete(caller);
    }
  };

  /**
   * Wait for a slot until `waitLimit` fires (the read's own bounded timeout,
   * which the caller owns) or the caller cancels, or leave at once when the
   * queue already says the read cannot start within `maxWaitMs`. An admitted
   * read must call `release` once its response has been read.
   */
  const acquire = async ({
    waitLimit,
    signal,
    maxWaitMs,
  }: {
    waitLimit: AbortSignal;
    signal?: AbortSignal | undefined;
    /** What `waitLimit` allows, for the estimate; absent skips the estimate. */
    maxWaitMs?: number | undefined;
  }): Promise<CorpusSearchAdmission> => {
    const startedAt = now();
    const { inFlight, queued: queuedAhead } = budget.stats();
    const patient = patientReads.getStore() === true;
    if (
      !patient &&
      maxWaitMs !== undefined &&
      inFlight >= slots &&
      queuedAhead > 0 &&
      estimatedWaitMs() > maxWaitMs
    ) {
      return {
        type: "refused",
        reason: "deadline",
        waitedMs: 0,
        queued: queuedAhead,
      };
    }
    const caller = searchCaller.getStore();
    const virtualStart = enterFlow(caller);
    const waitSignal =
      signal === undefined ? waitLimit : AbortSignal.any([signal, waitLimit]);
    const request = { signal: waitSignal, rank: admissionRank(virtualStart) };
    let result = await budget.acquire(request);
    let retriedFullQueue = false;
    if (patient) {
      while (
        result.type === "refused" &&
        result.reason === "busy" &&
        !waitSignal.aborted
      ) {
        // Not cancelled by the wait limit: the next acquire reports it.
        retriedFullQueue = true;
        await sleep(FULL_QUEUE_RETRY_MS);
        result = await budget.acquire(request);
      }
    }
    leaveFlow(caller);
    const waitedMs = now() - startedAt;
    if (result.type === "admitted") {
      virtualNow = Math.max(virtualNow, virtualStart);
      const admittedAt = now();
      return {
        type: "admitted",
        release: () => {
          recordServiceMs(now() - admittedAt);
          result.release();
        },
        // A read admitted without queueing waited for nothing: the time to
        // resume after the await is not time spent waiting for a slot.
        waitedMs: result.queued || retriedFullQueue ? waitedMs : 0,
      };
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

  return { acquire, estimatedWaitMs, stats: budget.stats };
};

export type CorpusSearchAdmissionGate = ReturnType<
  typeof createCorpusSearchAdmission
>;
