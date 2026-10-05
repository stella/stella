// parser-output-unchanged: Counts recovered documents independently of secondary-read quality; fetched pages and parsed document fields are unchanged.
// parser-output-unchanged: telemetry observation forwards the original page and publisher responses.
import { Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { hasUsableAst } from "@stll/legal-ast/document-ast";
import {
  DOCUMENT_FETCH_EVENT,
  DOCUMENT_FETCH_OUTCOME,
  documentFetchErrorOutcome,
  documentFetchResponseOutcome,
  type DocumentFetchObservation,
  type DocumentStageObserver,
  type DocumentStageObservation,
  type DocumentTelemetryObserverFailure,
} from "@stll/legal-atlas/document-fetch-diagnostics";
import {
  createDocumentObserverBudget,
  createSafeDocumentStageObserver,
  observeDocumentStageSafely,
} from "@stll/legal-atlas/document-stage-observer";

import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import type { SyncPage } from "@/api/lib/legal-search/ingestion-types";
import {
  OBSERVATION_DETAIL,
  observationDetailOf,
} from "@/api/lib/legal-search/partial-observation-sql";

type DocumentWindowContext = {
  source: AdapterKey;
  observe: ReturnType<typeof createSafeDocumentStageObserver>;
  budget: ReturnType<typeof createDocumentObserverBudget>;
  /** Separate from `budget`, so a slow callback cannot starve the built-in log. */
  logBudget: ReturnType<typeof createDocumentObserverBudget>;
  log: ReturnType<typeof createSafeDocumentStageObserver>;
  attempted: number;
  failed: number;
  observations: DocumentFetchObservation[];
};

const documentWindow = new AsyncLocalStorage<DocumentWindowContext>();

/**
 * Settle `run` once and keep its promise: awaiting `attempt` again re-raises
 * the original rejection reason unchanged, whatever value it is.
 */
const settle = async <T>(run: () => Promise<T>) => {
  const attempt = (async () => await run())();
  const result = await Result.tryPromise({
    try: async () => await attempt,
    catch: (error) => error,
  });
  return { attempt, result };
};

const reportDocumentStageObserverFailure = async (
  { event, ...attributes }: DocumentTelemetryObserverFailure,
  signal: AbortSignal,
): Promise<void> => {
  const { logger } = await import("@/api/lib/observability/logger");
  signal.throwIfAborted();
  logger.warn(event, attributes);
};

type DocumentStageObserverOptions<T> = {
  source: AdapterKey;
  observe?: DocumentStageObserver | undefined;
  execute: () => Promise<T>;
  outcome?: (value: T) => DocumentFetchObservation["outcome"];
};

/** Forward deferred fetch events without emitting a competing page window. */
export const withDocumentStageObserver = async <T>({
  source,
  observe,
  execute,
  outcome,
}: DocumentStageObserverOptions<T>): Promise<T> => {
  const parent = documentWindow.getStore();
  const inheritedObserver =
    parent?.source === source ? parent.observe : undefined;
  const budget =
    parent?.source === source
      ? parent.budget
      : createDocumentObserverBudget(observe);
  const logBudget =
    parent?.source === source
      ? parent.logBudget
      : createDocumentObserverBudget();
  const context: DocumentWindowContext = {
    source,
    budget,
    logBudget,
    observe: createSafeDocumentStageObserver(
      observe ?? inheritedObserver ?? (() => undefined),
      { budget, reportFailure: reportDocumentStageObserverFailure },
    ),
    log: createSafeDocumentStageObserver(writeDocumentStageObservation, {
      budget: logBudget,
      observer: "builtin",
      reportFailure: reportDocumentStageObserverFailure,
    }),
    attempted: 0,
    failed: 0,
    observations: [],
  };
  const { attempt, result } = await documentWindow.run(
    context,
    async () => await settle(execute),
  );
  if (Result.isError(result)) {
    recordTerminalFailure(
      context,
      documentFetchErrorOutcome(source, result.error),
    );
  } else {
    const terminalOutcome = outcome?.(result.value);
    if (
      terminalOutcome !== undefined &&
      terminalOutcome !== DOCUMENT_FETCH_OUTCOME.ok
    ) {
      recordTerminalFailure(context, {
        event: DOCUMENT_FETCH_EVENT.fetchOutcome,
        source,
        outcome: terminalOutcome,
      });
    }
  }
  await flushFetchOutcomes(context);
  if (Result.isError(result)) {
    return await attempt;
  }
  return result.value;
};

const writeDocumentStageObservation = async ({
  event,
  ...attributes
}: DocumentStageObservation): Promise<void> => {
  const { logger } = await import("@/api/lib/observability/logger");
  logger.info(event, attributes);
};

/** Load the operational sink only when emitting, so pure ingestion utilities stay import-safe. */
const logDocumentStageObservation = async (
  observation: DocumentStageObservation,
): Promise<void> => {
  await observeDocumentStageSafely({
    observation,
    observer: "builtin",
    observe: writeDocumentStageObservation,
    reportFailure: reportDocumentStageObserverFailure,
  });
};

const emitFetchOutcome = async (
  observation: DocumentFetchObservation,
): Promise<void> => {
  const context = documentWindow.getStore();
  if (context?.source !== observation.source) {
    await logDocumentStageObservation(observation);
    return;
  }
  context.attempted += 1;
  if (observation.outcome !== DOCUMENT_FETCH_OUTCOME.ok) {
    context.failed += 1;
  }
  // A successful response can still fail while reading or validating its body.
  // Keep attempt order, but publish only after the document/page has settled.
  context.observations.push(observation);
};

const recordTerminalFailure = (
  context: DocumentWindowContext,
  failure: DocumentFetchObservation,
): void => {
  const last = context.observations.at(-1);
  if (last?.outcome === DOCUMENT_FETCH_OUTCOME.ok) {
    const httpStatus = failure.http_status ?? last.http_status;
    context.observations[context.observations.length - 1] = {
      event: failure.event,
      source: failure.source,
      outcome: failure.outcome,
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    };
    context.failed += 1;
    return;
  }
  if (context.failed > 0) {
    return;
  }
  context.observations.push(failure);
  context.attempted += 1;
  context.failed += 1;
};

const flushFetchOutcomes = async (
  context: DocumentWindowContext,
  window?: DocumentStageObservation,
): Promise<void> => {
  // Deliver built-in events before callbacks can consume the shared page budget.
  for (const observation of context.observations) {
    await context.log(observation);
  }
  if (window !== undefined) {
    await context.log(window);
  }
  for (const observation of context.observations) {
    await context.observe(observation);
  }
  if (window !== undefined) {
    await context.observe(window);
  }
};

/** Retain the original structured body error even when the document unit returns a retry outcome. */
export const recordDocumentStageError = async (
  source: AdapterKey,
  error: unknown,
): Promise<void> => {
  const observation = documentFetchErrorOutcome(source, error);
  const context = documentWindow.getStore();
  if (context?.source === source) {
    recordTerminalFailure(context, observation);
    return;
  }
  await logDocumentStageObservation(observation);
};

type ObserveDocumentFetchOptions = {
  source: AdapterKey;
  fetch: () => Promise<Response>;
  expectedContentType?: "pdf" | undefined;
  responseOutcome?:
    | ((response: Response) => DocumentFetchObservation)
    | undefined;
};

/** Preserve response/error identity and leave body consumption to the adapter. */
export const observePublisherDocumentFetch = async ({
  source,
  fetch,
  expectedContentType,
  responseOutcome,
}: ObserveDocumentFetchOptions): Promise<Response> => {
  const { attempt, result } = await settle(fetch);
  if (Result.isError(result)) {
    await emitFetchOutcome(documentFetchErrorOutcome(source, result.error));
    return await attempt;
  }
  const response = result.value;
  const observation =
    responseOutcome?.(response) ??
    documentFetchResponseOutcome(source, response);
  const mime = response.headers
    .get("content-type")
    ?.split(";")
    .at(0)
    ?.trim()
    .toLowerCase();
  if (
    response.ok &&
    expectedContentType === "pdf" &&
    mime !== "application/pdf" &&
    mime !== "application/octet-stream"
  ) {
    await emitFetchOutcome({
      ...observation,
      outcome: DOCUMENT_FETCH_OUTCOME.bodyShape,
    });
    return response;
  }
  await emitFetchOutcome(observation);
  return response;
};

export type DocumentStagePageOptions = {
  source: AdapterKey;
  fetchPage: () => Promise<Result<SyncPage, AdapterFetchError>>;
  observe?: DocumentStageObserver | undefined;
  now?: (() => number) | undefined;
};

/** Async context keeps concurrent sources and pages from sharing counters. */
export const withDocumentStageWindow = async ({
  source,
  fetchPage,
  observe = () => undefined,
  now = () => performance.now(),
}: DocumentStagePageOptions): Promise<Result<SyncPage, AdapterFetchError>> => {
  const budget = createDocumentObserverBudget(observe);
  const logBudget = createDocumentObserverBudget();
  const context: DocumentWindowContext = {
    source,
    budget,
    logBudget,
    observe: createSafeDocumentStageObserver(observe, {
      budget,
      reportFailure: reportDocumentStageObserverFailure,
    }),
    log: createSafeDocumentStageObserver(writeDocumentStageObservation, {
      budget: logBudget,
      observer: "builtin",
      reportFailure: reportDocumentStageObserverFailure,
    }),
    attempted: 0,
    failed: 0,
    observations: [],
  };
  const startedAt = now();
  const { attempt, result: fetched } = await documentWindow.run(
    context,
    async () => await settle(fetchPage),
  );
  let filled = 0;
  let unresolved = 0;
  if (Result.isError(fetched)) {
    recordTerminalFailure(
      context,
      documentFetchErrorOutcome(source, fetched.error),
    );
  } else if (Result.isError(fetched.value)) {
    recordTerminalFailure(
      context,
      documentFetchErrorOutcome(source, fetched.value.error),
    );
  } else {
    const page = fetched.value.value;
    for (const decision of page.decisions) {
      if (decision.documentDelivery === "deferred") {
        continue;
      }
      if (
        observationDetailOf(decision) === OBSERVATION_DETAIL.LISTING_ONLY ||
        !(
          hasUsableAst(decision.documentAst) ||
          Boolean(decision.fulltext?.trim())
        )
      ) {
        unresolved += 1;
        continue;
      }
      filled += 1;
    }
    if (page.supplements !== undefined) {
      for (const { document } of page.supplements) {
        if (
          !(
            hasUsableAst(document.documentAst) ||
            Boolean(document.fulltext?.trim())
          )
        ) {
          unresolved += 1;
          continue;
        }
        filled += 1;
      }
    }
  }
  const observation = {
    event: DOCUMENT_FETCH_EVENT.window,
    aggregation: "page",
    source,
    backlog:
      Result.isError(fetched) || Result.isError(fetched.value) || unresolved > 0
        ? 1
        : 0,
    attempted: Math.max(context.attempted, filled + unresolved),
    filled,
    failed: Math.max(context.failed, unresolved),
    window_seconds: Math.max(0, now() - startedAt) / 1000,
  } as const;
  await flushFetchOutcomes(context, observation);
  if (Result.isError(fetched)) {
    return await attempt;
  }
  return fetched.value;
};
