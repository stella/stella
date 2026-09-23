import { Result } from "better-result";

import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { scanUpload } from "@/api/lib/file-scan/scanned-file";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * Filled template output, scanned before it reaches PDF conversion. Stricter
 * than an upload: a warning verdict fails too, so null means "do not convert".
 */
export const scanTemplateOutput = async ({
  buffer,
  fileName,
}: {
  buffer: Uint8Array;
  fileName: string;
}): Promise<ScannedFile | null> => {
  const scanned = await scanUpload({
    bytes: buffer,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName,
  });
  if (Result.isError(scanned)) {
    return null;
  }
  const { source } = scanned.value;
  return source.type === "scan" && source.scan.verdict === "pass"
    ? scanned.value
    : null;
};
