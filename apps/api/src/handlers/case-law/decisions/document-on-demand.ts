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
 * The bounds above are per process. The cross-process claim that keeps
 * two replicas off one document lives in the fetch unit itself, which
 * is also where the database access is: this module stays free of it,
 * so importing it never opens a connection pool. `document-on-demand-
 * deps.ts` holds the wiring, and `get-deferred-document.ts` puts the
 * two together for the public read.
 */

import { Result } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  BackfilledDocument,
  DecisionDocumentOutcome,
  PendingDocument,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";

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

const runFetch = async (
  decision: PendingDocument,
  deps: OnDemandDocumentDeps,
): Promise<BackfilledDocument | null> => {
  const outcome = await Result.tryPromise(
    async () => await deps.fetchDocument(decision),
  );

  if (Result.isError(outcome)) {
    captureError(outcome.error, {
      source: CAPTURE_SOURCE,
      decisionId: decision.id,
    });
    return null;
  }

  return outcome.value.status === "filled" ? outcome.value.document : null;
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

const withReadBudget = async (
  flight: Promise<BackfilledDocument | null>,
): Promise<BackfilledDocument | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, READ_BUDGET_MS);
  });

  try {
    return await Promise.race([flight, budget]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Fetch this decision's document for the reader asking for it, or
 * return null and leave it to the queue.
 */
export const readThroughDeferredDocument = async (
  decision: PendingDocument,
  deps: OnDemandDocumentDeps,
): Promise<BackfilledDocument | null> => {
  // The whole read-through — including the request recording — runs
  // inside the read budget: a stalled ingestion pool or a locked row
  // must never hold a public read. The recording write is idempotent
  // (first request wins), so if the budget expires mid-write and the
  // write lands afterwards anyway, the queue still learns of the demand.
  const attempt = async (): Promise<BackfilledDocument | null> => {
    // Recorded before anything can turn the fetch down, so a reader who
    // arrives with the slots full, or whose wait runs out, still moves
    // this decision to the front of the queue.
    const recorded = await Result.tryPromise(
      async () => await deps.recordRequest(decision.id),
    );
    if (Result.isError(recorded)) {
      captureError(recorded.error, {
        source: CAPTURE_SOURCE,
        decisionId: decision.id,
      });
    }

    const existing = inFlight.get(decision.id);
    if (!existing && inFlight.size >= CONCURRENT_FETCH_LIMIT) {
      return null;
    }

    return await (existing ?? startFetch(decision, deps));
  };

  return await withReadBudget(attempt());
};
