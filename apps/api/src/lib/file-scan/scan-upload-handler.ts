/**
 * The upload scan as request handlers answer it. Kept apart from
 * `scan-upload.ts`, which public routes import without telemetry: this side
 * reports the errors behind refusals raised because inspection itself failed.
 */
import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import type {
  FileScanFailedError,
  ScanUploadInput,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const INSPECTION_FAILURE_SINK = failureSink({
  event: "file_scan.inspection_failed",
  expected: [],
});

/**
 * Reports the errors behind a rejection that inspection could not complete.
 * Every caller that answers a scan error passes it through here.
 */
export const observeScanFailures = (
  error: FileScanRejectedError | FileScanFailedError,
): void => {
  if (!FileScanRejectedError.is(error)) {
    return;
  }
  for (const failure of error.inspectionFailures) {
    observeFailure(failure, {
      sink: INSPECTION_FAILURE_SINK,
      ctx: { feature: "file_scan" },
    });
  }
};

/**
 * A scan failure as a request handler answers it: a rejection is the
 * structured 422 security rejection. A scanner failure says nothing about the
 * bytes, so it is a retryable 503 rather than a verdict on the file.
 */
export const scanErrorForHandler = (
  error: FileScanRejectedError | FileScanFailedError,
  retryHint: string,
): HandlerError<422 | 503> => {
  observeScanFailures(error);
  return FileScanRejectedError.is(error)
    ? new HandlerError({ ...error.rejection, status: 422 })
    : new HandlerError({
        status: 503,
        message: "File security scan is unavailable",
        hint: retryHint,
        cause: error,
      });
};

/** `scanUpload` for request handlers, failing as {@link scanErrorForHandler}. */
export const scanUploadForHandler = async (
  input: ScanUploadInput,
  scan: typeof scanUpload = scanUpload,
): Promise<Result<ScannedFile, HandlerError<422 | 503>>> =>
  Result.mapError(await scan(input), (error) =>
    scanErrorForHandler(
      error,
      "Retry the upload; the same file can be sent again.",
    ),
  );
