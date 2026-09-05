/**
 * The continuous walk over the Slovak decisions waiting on their PDF.
 *
 * `sk-courts` stores metadata during the crawl and leaves the document
 * behind, so the backlog grows with every page ingested and a decision
 * still in it has no text to search, cite or read. The walk is therefore
 * a loop rather than a periodic sweep, and its throughput is one number:
 * the gap this sleeps between fetches. Nothing batches the work into an
 * interval, so nothing can throttle it below that gap by accident.
 *
 * The order is the queue's, not this loop's — decisions a reader asked
 * for first, then the newest of the rest — and each document goes
 * through the same idempotent unit the read path uses, so a fetch that
 * is abandoned, duplicated or overtaken converges on one stored
 * document.
 *
 * Kept free of the runner's DB, env and process imports so the pacing
 * and the priority handling can be exercised on their own.
 */

import type {
  DecisionDocumentOutcome,
  PendingDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import type { PendingDocumentQueue } from "@/api/lib/legal-search/sk-document-queue";

type DocumentOutcomeStatus = DecisionDocumentOutcome["status"];

/**
 * Per-status tallies. A `Record` over the unit's outcome union, so a new
 * outcome cannot be added without deciding how the summary reports it.
 */
type OutcomeCounts = Record<DocumentOutcomeStatus, number>;

export type SkDocumentDrainSummary = OutcomeCounts & {
  /** Documents taken from the queue during the window. */
  attempted: number;
  /**
   * Iterations that threw, whether the throw came from the fetch or
   * from the queue read that never reached a document. That is why this
   * does not have to equal `attempted` minus the outcome tallies.
   */
  failed: number;
  /**
   * The most recent throw, so an error rate has a cause beside it. Left
   * raw: the caller renders it, and it renders a tag rather than a
   * message, because a message can carry more than an operator asked to
   * see.
   */
  lastError: unknown;
};

const emptySummary = (): SkDocumentDrainSummary => ({
  attempted: 0,
  claimed: 0,
  failed: 0,
  filled: 0,
  lastError: undefined,
  superseded: 0,
  unavailable: 0,
});

const summaryIsEmpty = ({
  attempted,
  failed,
}: SkDocumentDrainSummary): boolean => attempted === 0 && failed === 0;

export type SkDocumentDrainTiming = {
  /**
   * Gap between two fetches. This is the politeness contract with the
   * publisher and the only thing that sets throughput.
   */
  fetchDelayMs: number;
  /** First sleep once the queue reads empty. */
  idleSleepMs: number;
  /** Ceiling the idle sleep doubles towards, so an empty queue is cheap. */
  idleSleepMaxMs: number;
  /** How often the tallies are emitted. */
  summaryIntervalMs: number;
  /** Ceiling the post-failure delay doubles towards. */
  failureBackoffMaxMs: number;
};

/**
 * Defaults for everything except the fetch gap, which is deployment
 * configuration: the gap decides how hard an external publisher is
 * asked, and these decide how cheaply the loop waits.
 */
export const SK_DOCUMENT_DRAIN_TIMING = {
  idleSleepMs: 30_000,
  idleSleepMaxMs: 15 * 60_000,
  summaryIntervalMs: 5 * 60_000,
  failureBackoffMaxMs: 60_000,
} as const satisfies Omit<SkDocumentDrainTiming, "fetchDelayMs">;

/**
 * The longest slice a pacing wait sleeps before re-checking the drain flag.
 * The idle ceiling is minutes; a SIGTERM must not wait it out.
 */
export const DRAIN_CHECK_SLICE_MS = 1000;

export type SkDocumentDrainOptions = {
  queue: PendingDocumentQueue;
  fetchDocument: (
    decision: PendingDocument,
  ) => Promise<DecisionDocumentOutcome>;
  /** Stops the walk without abandoning the fetch already in flight. */
  isDraining: () => boolean;
  now: () => number;
  /** Receives the periodic tallies; nothing is logged per document. */
  report: (summary: SkDocumentDrainSummary) => void;
  sleep: (ms: number) => Promise<void>;
  timing: SkDocumentDrainTiming;
};

/**
 * Walk the queue until the process drains.
 *
 * Every iteration ends in a sleep, and which sleep is the whole of the
 * pacing policy:
 *
 * - a fetch is followed by `fetchDelayMs`, whatever it returned. An
 *   unavailable document and a superseded store each consumed a
 *   download, and a document another worker held cost a database round
 *   trip; none of them earns a faster next fetch.
 * - an empty queue doubles its sleep towards the idle ceiling, so a
 *   drained backlog stops asking the database every half second. Any
 *   document found resets it.
 * - a throw doubles its delay towards the failure ceiling. This covers
 *   both shapes with one mechanism: a document the source keeps
 *   refusing, and a database that is unreachable for everything. Errors
 *   never break the loop — a transient failure leaves the decision
 *   pending and it comes back, an unparseable one is marked by the unit
 *   itself and does not.
 */
export const runSkDocumentDrain = async ({
  fetchDocument,
  isDraining,
  now,
  queue,
  report,
  sleep,
  timing,
}: SkDocumentDrainOptions): Promise<void> => {
  let summary = emptySummary();
  let summaryDueAt = now() + timing.summaryIntervalMs;
  let idleMs = timing.idleSleepMs;
  let consecutiveFailures = 0;

  const flushSummary = (): void => {
    if (!summaryIsEmpty(summary)) {
      report(summary);
    }
    summary = emptySummary();
    summaryDueAt = now() + timing.summaryIntervalMs;
  };

  while (!isDraining()) {
    let delayMs = timing.fetchDelayMs;

    try {
      const queued = await queue.next();

      if (queued === undefined) {
        delayMs = idleMs;
        idleMs = Math.min(idleMs * 2, timing.idleSleepMaxMs);
      } else {
        idleMs = timing.idleSleepMs;
        summary.attempted += 1;
        const outcome = await fetchDocument(queued.decision);
        summary[outcome.status] += 1;
      }

      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      summary.failed += 1;
      summary.lastError = error;
      delayMs = Math.min(
        timing.fetchDelayMs * 2 ** consecutiveFailures,
        timing.failureBackoffMaxMs,
      );
    }

    if (now() >= summaryDueAt) {
      flushSummary();
    }

    // The pacing itself: throughput is this gap, so the loop is sequential
    // by design. Sliced so a drain request interrupts an idle ceiling of
    // minutes within a second; a fetch gap under one slice sleeps once.
    let remainingMs = delayMs;
    while (remainingMs > 0 && !isDraining()) {
      const sliceMs = Math.min(remainingMs, DRAIN_CHECK_SLICE_MS);
      await sleep(sliceMs);
      remainingMs -= sliceMs;
    }
  }

  // A deployment must not discard the window in hand: without this the
  // tallies of a process replaced mid-window are never reported at all.
  flushSummary();
};
