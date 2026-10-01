// parser-output-unchanged: observer failure handling is isolated from parser results.
import { Result, TaggedError } from "better-result";

import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";

import {
  DOCUMENT_FETCH_EVENT,
  DOCUMENT_OBSERVER_TIMEOUT_MS,
  type DocumentStageObservation,
  type DocumentStageObserver,
  type DocumentTelemetryObserverFailure,
} from "./document-fetch-diagnostics.js";

class DocumentTelemetryObserverError extends TaggedError(
  "DocumentTelemetryObserverError",
)<{
  message: string;
  cause: unknown;
  reason: DocumentTelemetryObserverFailure["reason"];
}> {}

type DocumentStageObserverOptions = {
  observation: DocumentStageObservation;
  observe: DocumentStageObserver;
  observer: DocumentTelemetryObserverFailure["observer"];
  timeoutMs?: number;
  failureReason?: DocumentTelemetryObserverFailure["reason"];
  reportFailure?: (
    failure: DocumentTelemetryObserverFailure,
    signal: AbortSignal,
  ) => void | Promise<void>;
};

const reportObserverFailure = (
  { event, ...attributes }: DocumentTelemetryObserverFailure,
  signal: AbortSignal,
): void => {
  signal.throwIfAborted();
  process.stderr.write(`${JSON.stringify({ event, ...attributes })}\n`);
};

/** Telemetry cannot change a page's result, checkpoint, or drain pacing outcome. */
export const observeDocumentStageSafely = async ({
  observation,
  observe,
  observer,
  timeoutMs = DOCUMENT_OBSERVER_TIMEOUT_MS,
  reportFailure = reportObserverFailure,
  failureReason,
}: DocumentStageObserverOptions): Promise<
  DocumentTelemetryObserverFailure["reason"] | undefined
> => {
  const startedAt = performance.now();
  // Callers may tighten this budget, but cannot disable or extend it.
  const budgetMs = Number.isFinite(timeoutMs)
    ? Math.min(DOCUMENT_OBSERVER_TIMEOUT_MS, Math.max(0, timeoutMs))
    : DOCUMENT_OBSERVER_TIMEOUT_MS;
  const delivered =
    budgetMs === 0
      ? Result.err(
          new DocumentTelemetryObserverError({
            message: "Document telemetry budget exhausted",
            reason: "timeout",
            cause: undefined,
          }),
        )
      : await Result.tryPromise({
          try: async () =>
            await withTimeout(async () => await observe(observation), {
              label: DOCUMENT_FETCH_EVENT.observerFailed,
              timeoutMs: budgetMs,
            }),
          catch: (cause) =>
            new DocumentTelemetryObserverError({
              message: "Document telemetry observer failed",
              reason: cause instanceof TimeoutError ? "timeout" : "exception",
              cause,
            }),
        });
  if (Result.isOk(delivered)) {
    return;
  }
  const failure = {
    event: DOCUMENT_FETCH_EVENT.observerFailed,
    source: observation.source,
    observer,
    reason: failureReason ?? delivered.error.reason,
  } as const satisfies DocumentTelemetryObserverFailure;
  const remainingMs = budgetMs - (performance.now() - startedAt);
  const reported = await Result.tryPromise({
    try: async () => {
      await withTimeout(
        async (signal) => await reportFailure(failure, signal),
        {
          label: DOCUMENT_FETCH_EVENT.observerFailed,
          timeoutMs: Math.max(1, remainingMs),
        },
      );
    },
    catch: (cause) =>
      new DocumentTelemetryObserverError({
        message: "Document telemetry failure reporter failed",
        reason: cause instanceof TimeoutError ? "timeout" : "exception",
        cause,
      }),
  });
  if (Result.isOk(reported)) {
    return delivered.error.reason;
  }
  // The final fallback contains only the typed event, never the thrown payload.
  // If both operational sinks fail, ingestion must still remain independent.
  Result.try({
    try: () => process.stderr.write(`${JSON.stringify(failure)}\n`),
    catch: (cause) =>
      new DocumentTelemetryObserverError({
        message: "Document telemetry fallback failed",
        reason: "exception",
        cause,
      }),
  });
  return delivered.error.reason;
};

type DocumentObserverBudget = { remainingMs: number };

/** Nested document units reuse their observer budget instead of extending the page deadline. */
export const createDocumentObserverBudget = (
  observe?: DocumentStageObserver,
): DocumentObserverBudget =>
  observe !== undefined && isSafeDocumentStageObserver(observe)
    ? observe[SAFE_DOCUMENT_OBSERVER]
    : { remainingMs: DOCUMENT_OBSERVER_TIMEOUT_MS };

type SafeDocumentStageObserverOptions = {
  reportFailure?: DocumentStageObserverOptions["reportFailure"];
  budget?: ReturnType<typeof createDocumentObserverBudget>;
  observer?: DocumentTelemetryObserverFailure["observer"];
};

const SAFE_DOCUMENT_OBSERVER = Symbol("safe-document-stage-observer");
type SafeDocumentStageObserver = ((
  observation: DocumentStageObservation,
) => Promise<void>) & {
  readonly [SAFE_DOCUMENT_OBSERVER]: DocumentObserverBudget;
};

const isSafeDocumentStageObserver = (
  observe: DocumentStageObserver,
): observe is SafeDocumentStageObserver => SAFE_DOCUMENT_OBSERVER in observe;

/** Idempotent wrapping prevents nested deadlines from logging the same failure twice. */
export const createSafeDocumentStageObserver = (
  observe: DocumentStageObserver,
  {
    reportFailure,
    budget = createDocumentObserverBudget(),
    observer = "callback",
  }: SafeDocumentStageObserverOptions = {},
): SafeDocumentStageObserver => {
  if (isSafeDocumentStageObserver(observe)) {
    return observe;
  }
  let circuit: "closed" | "open" = "closed";
  return Object.assign(
    async (observation: DocumentStageObservation) => {
      if (circuit === "open") {
        return;
      }
      const startedAt = performance.now();
      const failure = await observeDocumentStageSafely({
        observation,
        observe,
        observer,
        timeoutMs: budget.remainingMs,
        failureReason: "circuit_open",
        ...(reportFailure !== undefined ? { reportFailure } : {}),
      });
      budget.remainingMs = Math.max(
        0,
        budget.remainingMs - (performance.now() - startedAt),
      );
      if (failure !== undefined) {
        circuit = "open";
      }
    },
    { [SAFE_DOCUMENT_OBSERVER]: budget } as const,
  );
};
