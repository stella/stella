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
 */

import { Result } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type {
  BackfilledDocument,
  DecisionDocumentOutcome,
  PendingDocument,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import {
  fetchDecisionDocument,
  recordDocumentFetchRequest,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";

/** Sources that ingest metadata first and the document later. */
const DEFERRED_DOCUMENT_ADAPTER_KEYS: ReadonlySet<string> = new Set([
  ADAPTER_KEYS.SK_COURTS,
]);

/**
 * How long a read waits for a document. Deliberately shorter than the
 * fetch budget below: the reader gets an answer either way, and the
 * fetch it started keeps running for the next one.
 */
const READ_BUDGET_MS = 6000;

/**
 * Cap on one fetch, independent of the reader who triggered it. A
 * download plus parse is measured in seconds, so this bounds a stuck
 * fetch rather than a slow one.
 */
const FETCH_BUDGET_MS = 60_000;

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
  hasAst: boolean;
  fulltext: string | null;
  astS3Key: string | null;
  textS3Key: string | null;
};

/**
 * Whether this decision is one whose document has not been fetched yet.
 *
 * An empty `fulltext` is the "fetched and there was nothing" marker, so
 * only NULL counts as pending; a corpus key means the canonical payload
 * lives in object storage and the columns are empty by design.
 */
export const isDeferredDocumentPending = ({
  adapterKey,
  documentUrl,
  hasAst,
  fulltext,
  astS3Key,
  textS3Key,
}: DeferredDocumentState): boolean =>
  DEFERRED_DOCUMENT_ADAPTER_KEYS.has(adapterKey) &&
  documentUrl !== null &&
  !hasAst &&
  fulltext === null &&
  astS3Key === null &&
  textS3Key === null;

export type OnDemandDocumentDeps = {
  recordRequest: (decisionId: SafeId<"caseLawDecision">) => Promise<void>;
  fetchDocument: (
    decision: PendingDocument,
    signal: AbortSignal,
  ) => Promise<DecisionDocumentOutcome>;
};

const persistentDeps: OnDemandDocumentDeps = {
  recordRequest: async (decisionId) =>
    await recordDocumentFetchRequest(decisionId, caseLawIngestionDb),
  fetchDocument: async (decision, signal) =>
    await fetchDecisionDocument({
      decision,
      scopedDb: caseLawIngestionDb,
      signal,
    }),
};

const runFetch = async (
  decision: PendingDocument,
  deps: OnDemandDocumentDeps,
): Promise<BackfilledDocument | null> => {
  const outcome = await Result.tryPromise(
    async () =>
      await deps.fetchDocument(decision, AbortSignal.timeout(FETCH_BUDGET_MS)),
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

const startFetch = (
  decision: PendingDocument,
  deps: OnDemandDocumentDeps,
): Promise<BackfilledDocument | null> => {
  const flight = runFetch(decision, deps).finally(() => {
    inFlight.delete(decision.id);
  });
  inFlight.set(decision.id, flight);

  return flight;
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
 *
 * `deps` is the seam the tests drive; production passes nothing.
 */
export const readThroughDeferredDocument = async (
  decision: PendingDocument,
  deps: OnDemandDocumentDeps = persistentDeps,
): Promise<BackfilledDocument | null> => {
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

  return await withReadBudget(existing ?? startFetch(decision, deps));
};
