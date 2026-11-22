import { Result } from "better-result";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import { observeScanFailures } from "@/api/lib/file-scan/scan-upload-handler";

export const scanFilePartForSave = async ({
  bytes,
  fileName,
  mimeType,
}: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}) => {
  if (bytes.byteLength === 0) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: "file_empty",
        message: "File rejected: file is empty",
      }),
    );
  }

  const scanResult = await scanUpload({
    bytes,
    declaredMimeType: mimeType,
    fileName,
  });
  if (Result.isError(scanResult)) {
    observeScanFailures(scanResult.error);
    if (!FileScanRejectedError.is(scanResult.error)) {
      return Result.err(
        new HandlerError({
          status: 422,
          code: "file_scan_failed",
          message: "File security scan failed",
        }),
      );
    }
    const reasons = scanResult.error.rejection.issues.map(
      ({ message }) => message,
    );
    return Result.err(
      new HandlerError({
        status: 422,
        code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
        message: `File rejected: ${reasons.join("; ")}`,
      }),
    );
  }
  return Result.ok({
    scanned: scanResult.value,
    scanWarnings: scanResult.value.scanWarnings ?? undefined,
  });
};
