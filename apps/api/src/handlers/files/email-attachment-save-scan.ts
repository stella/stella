import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";

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

  const scanResult = await scanFile({
    buffer: bytes,
    declaredMimeType: mimeType,
    fileName,
  });
  if (Result.isError(scanResult)) {
    return Result.err(
      new HandlerError({ status: 422, message: "File security scan failed" }),
    );
  }
  if (scanResult.value.verdict === "reject") {
    const reasons = scanResult.value.findings.flatMap((finding) =>
      finding.severity === "reject" ? [finding.message] : [],
    );
    return Result.err(
      new HandlerError({
        status: 422,
        message: `File rejected: ${reasons.join("; ")}`,
      }),
    );
  }
  return Result.ok({
    scanWarnings: getScanWarnings(scanResult.value) ?? undefined,
  });
};
