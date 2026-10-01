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
  reportFailure?: (
    failure: DocumentTelemetryObserverFailure,
    signal: AbortSignal,
  ) => void | Promise<void>;
};

const reportObserverFailure = async (
  { event, ...attributes }: DocumentTelemetryObserverFailure,
  signal: AbortSignal,
): Promise<void> => {
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
}: DocumentStageObserverOptions): Promise<void> => {
  // Callers may tighten this budget, but cannot disable or extend it.
  const budgetMs = Number.isFinite(timeoutMs)
    ? Math.min(DOCUMENT_OBSERVER_TIMEOUT_MS, Math.max(1, timeoutMs))
    : DOCUMENT_OBSERVER_TIMEOUT_MS;
  const delivered = await Result.tryPromise({
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
    reason: delivered.error.reason,
  } as const satisfies DocumentTelemetryObserverFailure;
  const reported = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async (signal) => await reportFailure(failure, signal),
        {
          label: DOCUMENT_FETCH_EVENT.observerFailed,
          timeoutMs: budgetMs,
        },
      ),
    catch: (cause) =>
      new DocumentTelemetryObserverError({
        message: "Document telemetry failure reporter failed",
        reason: cause instanceof TimeoutError ? "timeout" : "exception",
        cause,
      }),
  });
  if (Result.isOk(reported)) {
    return;
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
};

const SAFE_DOCUMENT_OBSERVER = Symbol("safe-document-stage-observer");
type SafeDocumentStageObserver = ((
  observation: DocumentStageObservation,
) => Promise<void>) & {
  readonly [SAFE_DOCUMENT_OBSERVER]: true;
};

const isSafeDocumentStageObserver = (
  observe: DocumentStageObserver,
): observe is SafeDocumentStageObserver =>
  SAFE_DOCUMENT_OBSERVER in observe && observe[SAFE_DOCUMENT_OBSERVER] === true;

/** Idempotent wrapping prevents nested deadlines from logging the same failure twice. */
export const createSafeDocumentStageObserver = (
  observe: DocumentStageObserver,
  reportFailure?: DocumentStageObserverOptions["reportFailure"],
): SafeDocumentStageObserver => {
  if (isSafeDocumentStageObserver(observe)) {
    return observe;
  }
  return Object.assign(
    async (observation: DocumentStageObservation) => {
      await observeDocumentStageSafely({
        observation,
        observe,
        observer: "callback",
        ...(reportFailure !== undefined ? { reportFailure } : {}),
      });
    },
    { [SAFE_DOCUMENT_OBSERVER]: true } as const,
  );
};
