import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scanned-file";

export const scanEmailAttachmentForSave = async ({
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
    if (!FileScanRejectedError.is(scanResult.error)) {
      return Result.err(
        new HandlerError({ status: 422, message: "File security scan failed" }),
      );
    }
    const reasons = scanResult.error.rejection.issues.map(
      ({ message }) => message,
    );
    return Result.err(
      new HandlerError({
        status: 422,
        message: `File rejected: ${reasons.join("; ")}`,
      }),
    );
  }
  return Result.ok({
    scanned: scanResult.value,
    scanWarnings: scanResult.value.scanWarnings ?? undefined,
  });
};
