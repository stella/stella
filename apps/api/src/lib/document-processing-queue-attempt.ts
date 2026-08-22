import type { documentProcessingRuns } from "@/api/db/schema";
import {
  AUTOMATIC_OCR_MAX_ATTEMPTS,
  SEARCHABLE_PDF_FAILURE_CODE,
  SEARCH_INDEX_FAILURE_CODE,
} from "@/api/lib/document-processing-queue-policy";

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
