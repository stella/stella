/**
 * Fetch a deferred court document while a reader is waiting for it.
 *
 * Some sources are ingested metadata-first: the crawl stores what the
 * list and detail endpoints give it and leaves the document itself to
 * the queue in `ingestion/sk-document-backfill.ts`. A reader who opens
 * such a decision before the queue reaches it would otherwise see a
 * case number and nothing to read, so the read fetches a transient copy.
 * The queue persists its own fetch independently.
 *
 * Three bounds keep that from turning a read into an outbound crawl:
 * one fetch per decision and eligibility snapshot, a small cap on
 * concurrent fetches, and a wait shorter than the fetch it starts. A
 * different snapshot does not share the result. Past the wait, the reader
 * gets metadata only and the transient fetch continues; a later read can
 * fetch again unless the independent queue has persisted the document.
 * Nothing here can fail a read: failures are recorded and do not affect the
 * durable queue state.
 *
 * That last sentence is a guarantee, so it is enforced at one place
 * rather than restated at every await: `readThroughDeferredDocument`
 * settles its whole body through a single boundary that turns any
 * rejection into the metadata-only answer. The call site
 * (`get-deferred-document.ts`) awaits it bare and has no boundary of its
 * own, so a rejection that escaped here would 500 the public read; the
 * per-await wrapping below is defence in depth, not the guarantee.
 *
 * Read-through takes an immediate reservation from the queue’s shared
 * publisher gate at the outbound boundary; a busy or unavailable gate
 * leaves the read metadata-only.
 *
 * The bounds above are per process. This module stays free of database
 * access; `document-on-demand-deps.ts` wires transient reads and optional
 * durable demand recording, while the queue owns persistence.
 */

import { panic, Result, TaggedError, UnhandledException } from "better-result";

import type {
  ImmediatePublisherSlotResult,
  PublisherPacingOutcome,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  type DeferredDocumentAdapterKey,
  isDeferredDocumentAdapterKey,
} from "@/api/lib/legal-search/adapter-manifest";
import type {
  BackfilledDocument,
  DocumentFetchRequest,
  DecisionDocumentOutcome,
  PendingDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import { withTimeout } from "@/api/lib/with-timeout";

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

class DocumentPacingOutcome extends TaggedError("DocumentPacingOutcome")<{
  message: string;
  outcome: DocumentReadDeferral;
}> {}

export type DocumentReadDeferral =
  | PublisherPacingOutcome
  | "ownership-busy"
  | "ownership-lost";

const CAPTURE_SOURCE = "case-law-document-on-demand";

/**
 * In-flight fetches by decision. Same-revision readers may share one
 * transient document; a reader with a different eligibility snapshot cannot.
 * One entry per decision also bounds concurrent publisher fetches.
 */
type InFlightDocumentRead = {
  textEligibilityFingerprint: string;
  promise: Promise<BackfilledDocument | null>;
};

const inFlight = new Map<SafeId<"caseLawDecision">, InFlightDocumentRead>();

export type DeferredDocumentState = {
  adapterKey: string;
  documentUrl: string | null;
  documentPending: boolean;
  /**
   * Whether the read reported pending because object storage refused a
   * payload it does hold, rather than because nothing was ever fetched.
   */
  documentReadFailed: boolean;
};

/**
 * Whether a read may fetch this decision's document.
 *
 * `documentPending` is the read's own answer to "is anything readable
 * stored for this decision" — no text, no AST, and no canonical payload
 * in object storage. This adds the conditions the read does not judge:
 * the source has to be one that defers its documents, there has to be
 * something to fetch, and the pending state has to mean the document is
 * genuinely missing.
 *
 * That last one is the difference between a document nobody has fetched
 * and one object storage could not serve. The reader is told the same
 * thing either way, but a fetch would be pure waste for the second: the
 * store refuses a row that already carries a corpus document, so the
 * download could never land, and every reader during an outage would pay
 * for one and wait out the read budget behind it.
 */
export const isDeferredDocumentFetchable = ({
  adapterKey,
  documentUrl,
  documentPending,
  documentReadFailed,
}: DeferredDocumentState): boolean =>
  documentPending &&
  !documentReadFailed &&
  documentUrl !== null &&
  isDeferredDocumentAdapterKey(adapterKey);

/**
 * Demand recording and publisher pacing are supplied by the caller: the
 * tests drive them directly, and production passes the wiring from
 * `document-on-demand-deps.ts`. The fetched document itself is transient.
 */
export type OnDemandDocumentDeps = {
  recordRequest: (request: DocumentFetchRequest) => Promise<void>;
  fetchDocument: (
    decision: PendingDocument,
    adapterKey: DeferredDocumentAdapterKey,
  ) => Promise<DecisionDocumentOutcome>;
  withFetchBudget: (
    adapterKey: DeferredDocumentAdapterKey,
    operation: () => Promise<DecisionDocumentOutcome>,
  ) => Promise<ImmediatePublisherSlotResult<DecisionDocumentOutcome>>;
  recordPacingOutcome: (
    decisionId: SafeId<"caseLawDecision">,
    outcome: DocumentReadDeferral,
  ) => void;
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
): void =>
  // A failure of the recording itself is dropped on purpose: the
  // reporting channel is what broke, so there is nowhere left to report
  // that, and it must not be escalated into the read it was recording a
  // failure for.
  Result.try(() => {
    captureError(error, { source: CAPTURE_SOURCE, decisionId });
  }).unwrapOr(undefined);

export const recordDocumentPacingOutcome = (
  decisionId: SafeId<"caseLawDecision">,
  outcome: DocumentReadDeferral,
): void =>
  recordFailure(
    new DocumentPacingOutcome({
      message: `Document fetch ${outcome}`,
      outcome,
    }),
    decisionId,
  );

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

type FetchDeferredDocumentOptions = {
  decision: PendingDocument;
  deps: OnDemandDocumentDeps;
  adapterKey: DeferredDocumentAdapterKey;
};

const runFetch = async ({
  decision,
  deps,
  adapterKey,
}: FetchDeferredDocumentOptions): Promise<BackfilledDocument | null> => {
  // The outcome is read inside the guard, not after it: an unexpected
  // shape from the fetch unit would otherwise throw past the only thing
  // catching for this promise, and this promise is the one the read
  // budget abandons — a rejection landing after that has nothing
  // attached to it at all.
  const outcome = await Result.tryPromise(async () => {
    const budgeted = await deps.withFetchBudget(
      adapterKey,
      async () => await deps.fetchDocument(decision, adapterKey),
    );
    switch (budgeted.status) {
      case "pacing-deferred":
      case "pacing-unavailable":
        deps.recordPacingOutcome(decision.id, budgeted.status);
        return null;
      case "failed":
        recordFailure(budgeted.error, decision.id);
        return null;
      case "completed":
        if (
          budgeted.value.status === "busy" ||
          budgeted.value.status === "lost"
        ) {
          deps.recordPacingOutcome(
            decision.id,
            budgeted.value.status === "busy"
              ? "ownership-busy"
              : "ownership-lost",
          );
          return null;
        }
        return budgeted.value.status === "filled"
          ? budgeted.value.document
          : null;
      default: {
        budgeted satisfies never;
        return panic("Unhandled document fetch budget outcome");
      }
    }
  });

  if (Result.isError(outcome)) {
    recordFailure(outcome.error, decision.id);
    return null;
  }

  return outcome.value;
};

const startFetch = async ({
  decision,
  deps,
  adapterKey,
  textEligibilityFingerprint,
}: FetchDeferredDocumentOptions & {
  textEligibilityFingerprint: string;
}): Promise<BackfilledDocument | null> => {
  const flight = runFetch({ decision, deps, adapterKey }).finally(() => {
    const current = inFlight.get(decision.id);
    if (current?.promise === flight) {
      inFlight.delete(decision.id);
    }
  });
  inFlight.set(decision.id, { textEligibilityFingerprint, promise: flight });

  return await flight;
};

export type ReadThroughDeferredDocumentOptions = {
  decision: PendingDocument;
  /** Document revision observed with the read that decided this fetch was pending. */
  textRevisionFingerprint: string;
  adapterKey: string;
  deps: OnDemandDocumentDeps;
  /** Eligibility snapshot that permits this result to reach the response. */
  textEligibilityFingerprint: string;
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
  textRevisionFingerprint,
  adapterKey,
  deps,
  recordDemand,
  textEligibilityFingerprint,
}: ReadThroughDeferredDocumentOptions): Promise<BackfilledDocument | null> => {
  // The whole read-through — including the request recording — runs
  // inside the read budget: a stalled ingestion pool or a locked row
  // must never hold a public read. The recording write is idempotent
  // (first request wins), so if the budget expires mid-write and the
  // write lands afterwards anyway, the queue still learns of the demand.
  const attempt = async (): Promise<BackfilledDocument | null> => {
    if (!isDeferredDocumentAdapterKey(adapterKey)) {
      return null;
    }
    // Recorded before anything can turn the fetch down, so a reader who
    // arrives with the slots full, or whose wait runs out, still moves
    // this decision to the front of the queue.
    if (recordDemand) {
      const recorded = await Result.tryPromise(
        async () =>
          await deps.recordRequest({
            decisionId: decision.id,
            textRevisionFingerprint,
            documentUrl: decision.documentUrl,
          }),
      );
      if (Result.isError(recorded)) {
        recordFailure(recorded.error, decision.id);
      }
    }

    const existing = inFlight.get(decision.id);
    if (existing !== undefined) {
      return existing.textEligibilityFingerprint === textEligibilityFingerprint
        ? await existing.promise
        : null;
    }
    if (inFlight.size >= CONCURRENT_FETCH_LIMIT) {
      return null;
    }

    return await startFetch({
      decision,
      deps,
      adapterKey,
      textEligibilityFingerprint,
    });
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
