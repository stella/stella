import { panic, Result } from "better-result";

import { scanUpload } from "@/api/lib/file-scan/scan-upload";
import type { FileScanFailedError } from "@/api/lib/file-scan/scan-upload";
import { observeScanFailures } from "@/api/lib/file-scan/scan-upload-handler";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * Filled template output, scanned before it reaches PDF conversion. Stricter
 * than an upload: a warning verdict fails too, so null means "do not convert".
 * Inspection failures remain errors rather than a verdict on the output.
 */
export const scanTemplateOutput = async ({
  buffer,
  fileName,
}: {
  buffer: Uint8Array;
  fileName: string;
}): Promise<Result<ScannedFile | null, FileScanFailedError>> => {
  const scanned = await scanUpload({
    bytes: buffer,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName,
  });
  if (Result.isError(scanned)) {
    observeScanFailures(scanned.error);
    switch (scanned.error._tag) {
      case "FileScanFailedError":
        return Result.err(scanned.error);
      case "FileScanRejectedError":
        return Result.ok(null);
      default:
        scanned.error satisfies never;
        return panic("Unhandled template output scan failure");
    }
  }
  const { source } = scanned.value;
  return Result.ok(
    source.type === "scan" && source.scan.verdict === "pass"
      ? scanned.value
      : null,
  );
};
