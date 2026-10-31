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
import { admitWork, WorkRefusal } from "@/api/lib/load/work-admission";

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
};

/** Scans untrusted bytes; only a non-rejecting verdict yields a `ScannedFile`. */
export const scanUpload = async (
  { bytes, ownership = "copy", declaredMimeType, fileName }: ScanUploadInput,
  scan: typeof scanFile = scanFile,
): Promise<
  Result<ScannedFile, FileScanRejectedError | FileScanFailedError>
> => {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const admitted = await admitWork({
    pool: "file-scan",
    kind: "file-scan",
    bytes: view.byteLength,
    run: async () => {
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
    },
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
  const { buffer, scanned } = admitted.value;
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
