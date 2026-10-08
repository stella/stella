import { APIError } from "@/lib/errors/api";
import { PDFViewerError } from "@/lib/pdf/pdf-errors";
import { isStaleDeploymentLoadError } from "@/lib/preload-error-recovery";

/**
 * What a viewer does with a render or load failure.
 *
 * - `reload-app`: the running bundle is stale (a chunk or worker script from
 *   an earlier deploy is gone); only a fresh page module graph recovers.
 * - `retry`: worth another attempt with fresh data (a new signed URL, a new
 *   PDF.js worker): network loss, server errors, an expired storage URL.
 * - `final`: the server or the file answered for good (no rendition, no
 *   access, wrong password, a corrupt file); retrying repeats the answer.
 */
export type ViewerErrorRecovery =
  | { type: "reload-app" }
  | { type: "retry" }
  | { type: "final" };

const RETRYABLE_API_STATUSES: ReadonlySet<number> = new Set([0, 408, 429]);
const SERVER_ERROR_STATUS = 500;

/** PDF.js names a file it cannot parse; that does not change on retry. */
const FINAL_PDFJS_ERROR_NAMES: ReadonlySet<string> = new Set([
  "InvalidPDFException",
  "PasswordException",
]);

const FINAL_PDF_VIEWER_CODES = {
  CANCELLED: false,
  INCORRECT_PASSWORD: true,
  LOAD_FAILED: false,
  NO_RENDERABLE_PAGES: true,
  PASSWORD_REQUIRED: true,
} as const satisfies Record<PDFViewerError["code"], boolean>;

const errorName = (error: unknown): string | undefined =>
  error instanceof Error ? error.name : undefined;

const classifyAPIError = (error: APIError): ViewerErrorRecovery => {
  // A presigned storage URL answers 403 once it expires: the file is fine,
  // the URL is not. Every storage failure is retried with a fresh URL.
  if (error.details?.["phase"] !== undefined) {
    return { type: "retry" };
  }
  if (
    RETRYABLE_API_STATUSES.has(error.status) ||
    error.status >= SERVER_ERROR_STATUS
  ) {
    return { type: "retry" };
  }
  return { type: "final" };
};

export const classifyViewerError = (error: unknown): ViewerErrorRecovery => {
  if (isStaleDeploymentLoadError(error)) {
    return { type: "reload-app" };
  }
  if (APIError.is(error)) {
    return classifyAPIError(error);
  }
  if (PDFViewerError.is(error)) {
    if (FINAL_PDF_VIEWER_CODES[error.code]) {
      return { type: "final" };
    }
    if (isStaleDeploymentLoadError(error.cause)) {
      return { type: "reload-app" };
    }
    const causeName = errorName(error.cause);
    return causeName !== undefined && FINAL_PDFJS_ERROR_NAMES.has(causeName)
      ? { type: "final" }
      : { type: "retry" };
  }
  const name = errorName(error);
  return name !== undefined && FINAL_PDFJS_ERROR_NAMES.has(name)
    ? { type: "final" }
    : { type: "retry" };
};

/** Automatic attempts after the first failure, and the wait before each. */
export const VIEWER_RETRY_DELAYS_MS = [600, 2400] as const;

/**
 * The wait before automatic attempt `attempt` (0-based), or `undefined`
 * when automatic attempts are used up and the viewer shows its failed state.
 */
export const viewerRetryDelayMs = (
  attempt: number,
  delaysMs: readonly number[] = VIEWER_RETRY_DELAYS_MS,
): number | undefined => delaysMs.at(attempt);
