import { Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  DOCUMENT_FETCH_EVENT,
  DOCUMENT_FETCH_OUTCOME,
  documentFetchErrorOutcome,
  documentFetchResponseOutcome,
  type DocumentFetchObservation,
  type DocumentStageObserver,
  type DocumentStageObservation,
} from "@stll/legal-atlas/document-fetch-diagnostics";

import { hasUsableAst } from "@/api/lib/case-law/document-ast";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  observeDocumentStageSafely,
  createSafeDocumentStageObserver,
} from "@/api/lib/legal-search/document-stage-observer";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import type { SyncPage } from "@/api/lib/legal-search/ingestion-types";

type DocumentWindowContext = {
  source: AdapterKey;
  observe: ReturnType<typeof createSafeDocumentStageObserver>;
  attempted: number;
  failed: number;
};

const documentWindow = new AsyncLocalStorage<DocumentWindowContext>();

type DocumentStageObserverOptions<T> = {
  source: AdapterKey;
  observe: DocumentStageObserver;
  execute: () => Promise<T>;
};

/** Forward deferred fetch events without emitting a competing page window. */
export const withDocumentStageObserver = async <T>({
  source,
  observe,
  execute,
}: DocumentStageObserverOptions<T>): Promise<T> =>
  await documentWindow.run(
    {
      source,
      observe: createSafeDocumentStageObserver(observe),
      attempted: 0,
      failed: 0,
    },
    execute,
  );

/** Load the operational sink only when emitting, so pure ingestion utilities stay import-safe. */
export const logDocumentStageObservation = async (
  observation: DocumentStageObservation,
): Promise<void> => {
  await observeDocumentStageSafely({
    observation,
    observer: "builtin",
    observe: async ({ event, ...attributes }) => {
      const { logger } = await import("@/api/lib/observability/logger");
      logger.info(event, attributes);
    },
  });
};

const emitFetchOutcome = async (
  observation: DocumentFetchObservation,
): Promise<void> => {
  await logDocumentStageObservation(observation);
  const context = documentWindow.getStore();
  if (context?.source !== observation.source) {
    return;
  }
  context.attempted += 1;
  if (observation.outcome !== DOCUMENT_FETCH_OUTCOME.ok) {
    context.failed += 1;
  }
  await context.observe(observation);
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
  const result = await Result.tryPromise({
    try: fetch,
    catch: (error) => error,
  });
  if (Result.isError(result)) {
    await emitFetchOutcome(documentFetchErrorOutcome(source, result.error));
    throw result.error;
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
  const context = {
    source,
    observe: createSafeDocumentStageObserver(observe),
    attempted: 0,
    failed: 0,
  };
  const startedAt = now();
  const fetched = await documentWindow.run(
    context,
    async () =>
      await Result.tryPromise({ try: fetchPage, catch: (error) => error }),
  );
  let filled = 0;
  let unresolved = 0;
  const reportUnaccountedFailure = async (error: unknown): Promise<void> => {
    if (context.failed > 0) {
      return;
    }
    const observation = documentFetchErrorOutcome(source, error);
    context.attempted += 1;
    context.failed += 1;
    await logDocumentStageObservation(observation);
    await context.observe(observation);
  };
  if (Result.isError(fetched)) {
    await reportUnaccountedFailure(fetched.error);
  } else if (Result.isError(fetched.value)) {
    await reportUnaccountedFailure(fetched.value.error);
  } else {
    const page = fetched.value.value;
    filled = page.decisions.filter(
      (decision) =>
        decision.documentDelivery !== "deferred" &&
        (hasUsableAst(decision.documentAst) ||
          Boolean(decision.fulltext?.trim())),
    ).length;
    filled +=
      page.supplements?.filter(
        ({ document }) =>
          hasUsableAst(document.documentAst) ||
          Boolean(document.fulltext?.trim()),
      ).length ?? 0;
    unresolved = page.decisions.filter(
      (decision) =>
        decision.documentDelivery !== "deferred" &&
        decision.isListingOnly === true,
    ).length;
  }
  const observation = {
    event: DOCUMENT_FETCH_EVENT.window,
    aggregation: "page",
    source,
    backlog: context.failed > 0 || unresolved > 0 ? 1 : 0,
    attempted: Math.max(context.attempted, filled + unresolved),
    filled,
    failed: Math.max(context.failed, unresolved),
    window_seconds: Math.max(0, now() - startedAt) / 1000,
  } as const;
  await logDocumentStageObservation(observation);
  await context.observe(observation);
  if (Result.isError(fetched)) {
    throw fetched.error;
  }
  return fetched.value;
};
