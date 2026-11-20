/**
 * The scanning half of the `ScannedFile` boundary (see `scanned-file.ts`):
 * untrusted bytes become a `ScannedFile` only through a non-rejecting scan.
 */
import { panic, Result, TaggedError } from "better-result";

import type { ApiFileSecurityRejection } from "@stll/api-contract";

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
  /** Errors behind refusals raised because inspection itself failed; the
   *  caller reports them (see `scan-upload-handler.ts`). */
  inspectionFailures: readonly unknown[];
}> {}

export class FileScanFailedError extends TaggedError("FileScanFailedError")<{
  message: string;
  cause?: unknown;
}> {}

export type ScanUploadInput = {
  bytes: ArrayBuffer | Uint8Array;
  /** Transfer detaches an exclusively owned, exact-fit buffer; other inputs copy. */
  ownership?: "copy" | "transfer";
  declaredMimeType: string;
  fileName: string;
  /**
   * `process` (the default) admits the scan into this API process's file-scan
   * pool. `subprocess` is for a worker process (text extraction), which runs
   * outside the API's pools, bounded by its own timeout, and has no server
   * environment to load them from.
   */
  admission?: "process" | "subprocess";
};

/** Scans untrusted bytes; only a non-rejecting verdict yields a `ScannedFile`. */
export const scanUpload = async (
  {
    bytes,
    ownership = "copy",
    declaredMimeType,
    fileName,
    admission = "process",
  }: ScanUploadInput,
  scan: typeof scanFile = scanFile,
): Promise<
  Result<ScannedFile, FileScanRejectedError | FileScanFailedError>
> => {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const run = async () => {
    // Detaching the caller's aliases preserves verdict isolation without
    // copying. Subranges and shared buffers need an exact-fit private copy.
    const buffer =
      ownership === "transfer" &&
      view.buffer instanceof ArrayBuffer &&
      view.byteOffset === 0 &&
      view.byteLength === view.buffer.byteLength
        ? view.buffer.transfer()
        : new Uint8Array(view).buffer;
    const scanned = await scan({
      buffer: new Uint8Array(buffer),
      declaredMimeType,
      fileName,
    });
    return { buffer, scanned };
  };
  let completed: Awaited<ReturnType<typeof run>>;
  if (admission === "subprocess") {
    completed = await run();
  } else {
    // Loaded on use: the admission pools read the server environment, which
    // a worker subprocess does not have.
    const { admitWork, WorkRefusal } =
      await import("@/api/lib/load/work-admission");
    const admitted = await admitWork({
      pool: "file-scan",
      kind: "file-scan",
      bytes: view.byteLength,
      run,
    });
    if (Result.isError(admitted)) {
      return Result.err(
        new FileScanFailedError({
          message: WorkRefusal.is(admitted.error)
            ? "File security scan is busy"
            : "File security scan failed",
          cause: admitted.error,
        }),
      );
    }
    completed = admitted.value;
  }
  const { buffer, scanned } = completed;
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
      new FileScanRejectedError({
        message: rejection.message,
        rejection,
        inspectionFailures: scanned.value.findings.flatMap(({ failure }) =>
          failure === undefined ? [] : [failure],
        ),
      }),
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
