/**
 * Fetch a deferred court document while a reader is waiting for it.
 *
 * Some sources are ingested metadata-first: the crawl stores what the
 * list and detail endpoints give it and leaves the document itself to
 * the queue in `ingestion/sk-document-backfill.ts`. A reader who opens
 * such a decision before the queue reaches it would otherwise see a
 * case number and nothing to read, so the read fetches the document
 * itself, through the same unit the queue runs.
 *
 * Three bounds keep that from turning a read into an outbound crawl:
 * one fetch per decision no matter how many readers arrive, a small cap
 * on concurrent fetches, and a wait shorter than the fetch it starts.
 * Past the wait the reader gets the metadata-only decision and the
 * fetch continues; whoever opens the decision next finds it stored.
 * Nothing here can fail a read — a failure is recorded and the decision
 * stays queued.
 *
 * That last sentence is a guarantee, so it is enforced at one place
 * rather than restated at every await: `readThroughDeferredDocument`
 * settles its whole body through a single boundary that turns any
 * rejection into the metadata-only answer. The call site
 * (`get-deferred-document.ts`) awaits it bare and has no boundary of its
 * own, so a rejection that escaped here would 500 the public read; the
 * per-await wrapping below is defence in depth, not the guarantee.
 *
 * The bounds above are per process. The cross-process claim that keeps
 * two replicas off one document lives in the fetch unit itself, which
 * is also where the database access is: this module stays free of it,
 * so importing it never opens a connection pool. `document-on-demand-
 * deps.ts` holds the wiring, and `get-deferred-document.ts` puts the
 * two together for the public read.
 */

import { Result, UnhandledException } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import type {
  BackfilledDocument,
  DecisionDocumentOutcome,
  PendingDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import { withTimeout } from "@/api/lib/with-timeout";

/** Sources that ingest metadata first and the document later. */
const DEFERRED_DOCUMENT_ADAPTER_KEYS: ReadonlySet<string> = new Set([
  ADAPTER_KEYS.SK_COURTS,
]);

/**
 * How long a read waits for a document. Deliberately shorter than the
 * fetch unit's own budget: the reader gets an answer either way, and
 * the fetch it started keeps running for the next one.
 */
const READ_BUDGET_MS = 6000;

/** Names the budget's own expiry apart from a genuine failure. */
const READ_BUDGET_LABEL = "caseLaw.deferredDocumentRead";

/** Concurrent read-through fetches allowed at a time. */
const CONCURRENT_FETCH_LIMIT = 2;

const CAPTURE_SOURCE = "case-law-document-on-demand";

/**
 * In-flight fetches by decision. Doubles as the concurrency counter:
 * one entry is one running fetch, because the map is keyed by the
 * decision every arriving reader would otherwise fetch again.
 */
const inFlight = new Map<
  SafeId<"caseLawDecision">,
  Promise<BackfilledDocument | null>
>();

export type DeferredDocumentState = {
  adapterKey: string;
  documentUrl: string | null;
  documentPending: boolean;
};

/**
 * Whether a read may fetch this decision's document.
 *
 * `documentPending` is the read's own answer to "is anything readable
 * stored for this decision" — no text, no AST, and no canonical payload
 * in object storage. This adds the two conditions the read does not
 * judge: the source has to be one that defers its documents, and there
 * has to be something to fetch.
 */
export const isDeferredDocumentFetchable = ({
  adapterKey,
  documentUrl,
  documentPending,
}: DeferredDocumentState): boolean =>
  documentPending &&
  documentUrl !== null &&
  DEFERRED_DOCUMENT_ADAPTER_KEYS.has(adapterKey);

/**
 * The two durable effects this path needs. Both are supplied by the
 * caller: the tests drive them directly, and production passes the
 * database-backed pair from `document-on-demand-deps.ts`.
 */
export type OnDemandDocumentDeps = {
  recordRequest: (decisionId: SafeId<"caseLawDecision">) => Promise<void>;
  fetchDocument: (
    decision: PendingDocument,
  ) => Promise<DecisionDocumentOutcome>;
};

/**
 * Record a read-through failure without letting the recording become
 * one. `captureError` reaches the analytics client and the dev log
 * sink, so it is itself failable; a throw there would turn a recorded
 * failure into a failed read, which is exactly what this module
 * promises cannot happen.
 */
const recordFailure = (
  error: unknown,
  decisionId: SafeId<"caseLawDecision">,
): void => {
  Result.try(() => {
    captureError(error, { source: CAPTURE_SOURCE, decisionId });
  });
};

/**
 * Whether this is the read budget running out rather than something
 * failing. Expiry is the designed outcome for a document the source is
 * slow to serve, so reporting it would bury the failures that matter
 * under one event per slow read. `Result.tryPromise` reports a rejection
 * as an `UnhandledException` carrying the original as its cause, so the
 * label is read through that wrapper as well as directly.
 */
const isReadBudgetExpiry = (error: unknown): boolean => {
  const raised = error instanceof UnhandledException ? error.cause : error;
  return TimeoutError.is(raised) && raised.label === READ_BUDGET_LABEL;
};

const runFetch = async (
  decision: PendingDocument,
  deps: OnDemandDocumentDeps,
): Promise<BackfilledDocument | null> => {
  // The outcome is read inside the guard, not after it: an unexpected
  // shape from the fetch unit would otherwise throw past the only thing
  // catching for this promise, and this promise is the one the read
  // budget abandons — a rejection landing after that has nothing
  // attached to it at all.
  const outcome = await Result.tryPromise(async () => {
    const fetched = await deps.fetchDocument(decision);
    return fetched.status === "filled" ? fetched.document : null;
  });

  if (Result.isError(outcome)) {
    recordFailure(outcome.error, decision.id);
    return null;
  }

  return outcome.value;
};

const startFetch = async (
  decision: PendingDocument,
  deps: OnDemandDocumentDeps,
): Promise<BackfilledDocument | null> => {
  const flight = runFetch(decision, deps).finally(() => {
    inFlight.delete(decision.id);
  });
  inFlight.set(decision.id, flight);

  return await flight;
};

export type ReadThroughDeferredDocumentOptions = {
  decision: PendingDocument;
  deps: OnDemandDocumentDeps;
  /**
   * Whether this reader's interest is persisted as demand.
   *
   * Demand is a durable row that steers the ingestion queue: a recorded
   * decision jumps ahead of the whole backlog. That is right for a
   * reader we can attribute — a workspace session, an agent holding a
   * token — and wrong for an unauthenticated request, where anyone
   * walking the public decision ids could mint priority rows without
   * limit and decide what the crawler fetches next. Public reads still
   * hydrate when a slot happens to be free; they just leave no trace in
   * the queue.
   */
  recordDemand: boolean;
};

/**
 * Fetch this decision's document for the reader asking for it, or
 * return null and leave it to the queue.
 */
export const readThroughDeferredDocument = async ({
  decision,
  deps,
  recordDemand,
}: ReadThroughDeferredDocumentOptions): Promise<BackfilledDocument | null> => {
  // The whole read-through — including the request recording — runs
  // inside the read budget: a stalled ingestion pool or a locked row
  // must never hold a public read. The recording write is idempotent
  // (first request wins), so if the budget expires mid-write and the
  // write lands afterwards anyway, the queue still learns of the demand.
  const attempt = async (): Promise<BackfilledDocument | null> => {
    // Recorded before anything can turn the fetch down, so a reader who
    // arrives with the slots full, or whose wait runs out, still moves
    // this decision to the front of the queue.
    if (recordDemand) {
      const recorded = await Result.tryPromise(
        async () => await deps.recordRequest(decision.id),
      );
      if (Result.isError(recorded)) {
        recordFailure(recorded.error, decision.id);
      }
    }

    const existing = inFlight.get(decision.id);
    if (!existing && inFlight.size >= CONCURRENT_FETCH_LIMIT) {
      return null;
    }

    return await (existing ?? startFetch(decision, deps));
  };

  // The single boundary the module's guarantee rests on. Every await
  // inside is wrapped already, but that is discipline a later edit can
  // break silently, and the public read that calls this has no boundary
  // of its own: one escaping rejection turns a decision that is merely
  // waiting for its document into a 500. Failing here means the reader
  // gets the metadata-only decision, still marked pending, and the queue
  // keeps the work.
  //
  // The budget is the shared `withTimeout` rather than a local timer
  // race, so an attempt that settles after the deadline cannot surface
  // as an unhandled rejection. Expiry is the documented outcome, not a
  // failure, so it is the one error this does not report.
  const outcome = await Result.tryPromise(
    async () =>
      await withTimeout(async () => await attempt(), {
        label: READ_BUDGET_LABEL,
        timeoutMs: READ_BUDGET_MS,
      }),
  );
  if (Result.isError(outcome)) {
    if (!isReadBudgetExpiry(outcome.error)) {
      recordFailure(outcome.error, decision.id);
    }
    return null;
  }

  return outcome.value;
};
