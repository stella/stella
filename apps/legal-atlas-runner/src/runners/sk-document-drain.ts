import { panic, Result } from "better-result";
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

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import {
  DOCUMENT_FETCH_EVENT,
  documentFetchErrorOutcome,
  type DocumentStageObserver,
} from "@stll/legal-atlas/document-fetch-diagnostics";
import { createSafeDocumentStageObserver } from "@stll/legal-atlas/document-stage-observer";
import {
  type SkDocumentFetchErrorDiagnostic,
  skDocumentErrorDiagnostics,
} from "@stll/legal-atlas/sk-document-fetch-diagnostics";

import type {
  DecisionDocumentOutcome,
  DocumentFetchFailure,
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
   * Why the `deferred` and `parked` documents failed, per class. Total
   * over the failure union for the same reason as the outcome tallies.
   */
  failures: Record<DocumentFetchFailure, number>;
  /**
   * The most recent per-document failure's tag (a status or an error
   * code), so a failure class has a concrete cause beside it.
   */
  lastFailureDetail: string | undefined;
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
  /** Bounded classes only; never a URL, response body or error message. */
  lastErrorDiagnostic: SkDocumentFetchErrorDiagnostic | undefined;
};

const emptySummary = (): SkDocumentDrainSummary => ({
  attempted: 0,
  claimed: 0,
  deferred: 0,
  failed: 0,
  failures: {
    "publisher-status": 0,
    network: 0,
    "too-large": 0,
    unparseable: 0,
  } satisfies Record<DocumentFetchFailure, number>,
  filled: 0,
  lastError: undefined,
  lastErrorDiagnostic: undefined,
  lastFailureDetail: undefined,
  parked: 0,
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
  documentObservations?: {
    source: string;
    observe: DocumentStageObserver;
    hasPending: () => Promise<boolean>;
  };
  queue: PendingDocumentQueue;
  fetchDocument: (
    decision: PendingDocument,
    onDocumentObservation?: DocumentStageObserver,
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
 *   unavailable document, a superseded store and a document that failed
 *   each consumed a download, and a document another worker held cost a
 *   database round trip; none of them earns a faster next fetch, and a
 *   failed one earns no slower one either.
 * - an empty queue doubles its sleep towards the idle ceiling, so a
 *   drained backlog stops asking the database every half second. Any
 *   document found resets it.
 * - a scan that spent its row budget keeps the fetch gap: more candidates
 *   remain, so a page of cooling documents cannot trigger idle backoff.
 * - a throw doubles its delay towards the failure ceiling. The unit
 *   throws only for what may affect every document: an unreachable
 *   database, a publisher that is down, refusing this client or asking
 *   the walk to slow down, and a parse failure not attributed to the
 *   bytes. A document the source refuses on its own account is an
 *   outcome, bounded by its own cooldown in the queue; backing the whole
 *   walk off for it would let a few such documents at the head of the
 *   queue hold everything behind them. Errors never break the loop.
 */
export const runSkDocumentDrain = async ({
  fetchDocument,
  documentObservations,
  isDraining,
  now,
  queue,
  report,
  sleep,
  timing,
}: SkDocumentDrainOptions): Promise<void> => {
  const observations =
    documentObservations === undefined
      ? undefined
      : {
          ...documentObservations,
          observe: createSafeDocumentStageObserver(
            documentObservations.observe,
          ),
        };
  let summary = emptySummary();
  let windowStartedAt = now();
  let summaryDueAt = now() + timing.summaryIntervalMs;
  let idleMs = timing.idleSleepMs;
  let consecutiveFailures = 0;

  const flushSummary = async (): Promise<void> => {
    if (
      observations !== undefined &&
      (!summaryIsEmpty(summary) || now() > windowStartedAt)
    ) {
      let probeFailures = 0;
      const pending = await Result.tryPromise({
        try: observations.hasPending,
        catch: (error) => error,
      });
      const backlog = Result.isOk(pending) && !pending.value ? 0 : 1;
      if (Result.isError(pending)) {
        // Unknown queue health must never be presented as a healthy empty drain.
        probeFailures = 1;
        await observations.observe(
          documentFetchErrorOutcome(observations.source, pending.error),
        );
      }
      await observations.observe({
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "five_minute",
        source: observations.source,
        backlog,
        attempted: summary.attempted,
        filled: summary.filled,
        failed:
          summary.failed + summary.deferred + summary.parked + probeFailures,
        window_seconds: Math.max(0, now() - windowStartedAt) / 1000,
      });
    }
    if (!summaryIsEmpty(summary)) {
      report(summary);
    }
    summary = emptySummary();
    windowStartedAt = now();
    summaryDueAt = now() + timing.summaryIntervalMs;
  };

  while (!isDraining()) {
    let delayMs = timing.fetchDelayMs;

    try {
      const queued = await queue.next();

      switch (queued.type) {
        case "exhausted":
          delayMs = idleMs;
          idleMs = backoffDelay(1, {
            baseMs: idleMs,
            maxMs: timing.idleSleepMaxMs,
          });
          break;
        case "budget-spent":
          break;
        case "row": {
          idleMs = timing.idleSleepMs;
          summary.attempted += 1;
          const outcome = await fetchDocument(
            queued.row.decision,
            observations?.observe,
          );
          summary[outcome.status] += 1;
          if (outcome.status === "deferred" || outcome.status === "parked") {
            summary.failures[outcome.failure] += 1;
            summary.lastFailureDetail = outcome.detail;
          }
          break;
        }
        default: {
          queued satisfies never;
          panic("Unexpected document queue outcome");
        }
      }

      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      summary.failed += 1;
      summary.lastError = error;
      summary.lastErrorDiagnostic = skDocumentErrorDiagnostics(error);
      delayMs = backoffDelay(consecutiveFailures, {
        baseMs: timing.fetchDelayMs,
        maxMs: timing.failureBackoffMaxMs,
      });
    }

    if (now() >= summaryDueAt) {
      await flushSummary();
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
  await flushSummary();
};
