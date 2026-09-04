import { TaggedError } from "better-result";

import type { documentProcessingRuns } from "@/api/db/schema";
import {
  AUTOMATIC_OCR_MAX_ATTEMPTS,
  SEARCHABLE_PDF_FAILURE_CODE,
  SEARCH_INDEX_FAILURE_CODE,
} from "@/api/lib/document-processing-queue-policy";
import { isTransientRedisConnectionError } from "@/api/lib/redis-error-classification";

const AUTOMATIC_OCR_RETRY_BASE_DELAY_MS = 30_000;
const AUTOMATIC_OCR_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
const RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES = [
  "not_configured",
  "processing_failed",
  "request_failed",
] as const;

export const isLifecycleInterruptionError = ({
  error,
  lifecycleSignal,
}: {
  error: unknown;
  lifecycleSignal: AbortSignal;
}): boolean => {
  if (!lifecycleSignal.aborted) {
    return false;
  }

  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !visited.has(current)) {
    if (current === lifecycleSignal.reason) {
      return true;
    }
    visited.add(current);
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      return false;
    }
    current = current.cause;
  }
  return false;
};

export const settleDocumentProcessingAttemptError = async ({
  error,
  lifecycleSignal,
  markFailed,
  returnToQueue,
}: {
  error: unknown;
  lifecycleSignal: AbortSignal;
  markFailed: () => Promise<void>;
  returnToQueue: () => Promise<void>;
}): Promise<"failed" | "interrupted"> => {
  if (isLifecycleInterruptionError({ error, lifecycleSignal })) {
    await returnToQueue();
    return "interrupted";
  }
  await markFailed();
  return "failed";
};

/**
 * Wraps a failure the run-level path has already recorded.
 *
 * `markRunFailed` logs every attempt at the severity its outcome earns: WARN
 * while the durable retry model still has attempts left, ERROR with a capture
 * once at the terminal transition. The run then rethrows so BullMQ records the
 * job as failed, which hands the same error to the job-level handler. Without
 * a marker that handler cannot tell a settled attempt from machinery that
 * failed before any run was claimed, so it reports every attempt of a run that
 * is retrying by design.
 */
export class DocumentProcessingRunSettledError extends TaggedError(
  "DocumentProcessingRunSettledError",
)<{
  cause: unknown;
  message: string;
}> {}

export const DOCUMENT_PROCESSING_FAILURE_REPORT = {
  /** The run-level path already logged this attempt at its own severity. */
  ALREADY_REPORTED: "already-reported",
  /** Failed outside a claimed run, so this handler is its only reporter. */
  MACHINERY: "machinery",
  /** An expected Valkey transient that the job's own retry heals. */
  TRANSIENT_CONNECTION: "transient-connection",
} as const;

/**
 * A settled failure may wrap a connection error the run already reported, so
 * the settled marker has to be read before the transient classification.
 */
export const documentProcessingFailureReport = (error: unknown) => {
  if (error instanceof DocumentProcessingRunSettledError) {
    return DOCUMENT_PROCESSING_FAILURE_REPORT.ALREADY_REPORTED;
  }
  if (isTransientRedisConnectionError(error)) {
    return DOCUMENT_PROCESSING_FAILURE_REPORT.TRANSIENT_CONNECTION;
  }
  return DOCUMENT_PROCESSING_FAILURE_REPORT.MACHINERY;
};

export const automaticOcrRetryDelayMs = (attemptCount: number): number =>
  Math.min(
    AUTOMATIC_OCR_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1),
    AUTOMATIC_OCR_RETRY_MAX_DELAY_MS,
  );

export const isRetryableAutomaticOcrFailure = ({
  attemptCount,
  errorCode,
  requestSource,
}: {
  attemptCount: number;
  errorCode: string;
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"];
}): boolean =>
  requestSource !== "manual" &&
  attemptCount < AUTOMATIC_OCR_MAX_ATTEMPTS &&
  (errorCode === RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES[0] ||
    errorCode === RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES[1] ||
    errorCode === RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES[2]);

export const isRetryableSearchIndexFailure = (failureCode: string): boolean =>
  failureCode === SEARCH_INDEX_FAILURE_CODE;

export const isRetryableOcrDerivativeFailure = ({
  attemptCount,
  errorCode,
}: {
  attemptCount: number;
  errorCode: string;
}): boolean =>
  errorCode === SEARCHABLE_PDF_FAILURE_CODE &&
  attemptCount < AUTOMATIC_OCR_MAX_ATTEMPTS;

export const retryableOcrFailureCodes = RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES;
