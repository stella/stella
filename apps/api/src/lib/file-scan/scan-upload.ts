/**
 * The scanning half of the `ScannedFile` boundary (see `scanned-file.ts`):
 * untrusted bytes become a `ScannedFile` only through a non-rejecting scan.
 */
import { panic, Result, TaggedError } from "better-result";

import type { ApiFileSecurityRejection } from "@stll/api-contract";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { fileSecurityRejection } from "@/api/lib/file-scan/rejection";
import { scanFile } from "@/api/lib/file-scan/scan";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";
import { getScanWarnings } from "@/api/lib/file-scan/warnings";

export class FileScanRejectedError extends TaggedError(
  "FileScanRejectedError",
)<{
  message: string;
  rejection: ApiFileSecurityRejection;
}> {}

export class FileScanFailedError extends TaggedError("FileScanFailedError")<{
  message: string;
  cause?: unknown;
}> {}

type ScanUploadInput = {
  bytes: ArrayBuffer | Uint8Array;
  declaredMimeType: string;
  fileName: string;
};

/** Scans untrusted bytes; only a non-rejecting verdict yields a `ScannedFile`. */
export const scanUpload = async ({
  bytes,
  declaredMimeType,
  fileName,
}: ScanUploadInput): Promise<
  Result<ScannedFile, FileScanRejectedError | FileScanFailedError>
> => {
  // Scan and keep a private copy: a caller still holding its buffer must not
  // be able to change the bytes after the verdict.
  const buffer =
    bytes instanceof ArrayBuffer
      ? bytes.slice(0)
      : new Uint8Array(bytes).buffer;
  const scanned = await scanFile({
    buffer: new Uint8Array(buffer),
    declaredMimeType,
    fileName,
  });
  if (Result.isError(scanned)) {
    return Result.err(
      new FileScanFailedError({
        message: "File security scan failed",
        cause: scanned.error,
      }),
    );
  }
  if (scanned.value.verdict === "reject") {
    const rejection = fileSecurityRejection(scanned.value);
    if (rejection === null) {
      panic("Rejecting scan had no rejecting findings");
    }
    return Result.err(
      new FileScanRejectedError({ message: rejection.message, rejection }),
    );
  }
  return Result.ok(
    mintScannedFile({
      bytes: buffer,
      fileName,
      mimeType: declaredMimeType,
      source: {
        type: "scan",
        scan: scanned.value,
        warnings: getScanWarnings(scanned.value),
      },
    }),
  );
};

/**
 * A scan failure as a request handler answers it: a rejection is the
 * structured 422 security rejection. A scanner failure says nothing about the
 * bytes, so it is a retryable 503 rather than a verdict on the file.
 */
export const scanErrorForHandler = (
  error: FileScanRejectedError | FileScanFailedError,
  retryHint: string,
): HandlerError<422 | 503> =>
  FileScanRejectedError.is(error)
    ? new HandlerError({ ...error.rejection, status: 422 })
    : new HandlerError({
        status: 503,
        message: "File security scan is unavailable",
        hint: retryHint,
        cause: error,
      });

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
