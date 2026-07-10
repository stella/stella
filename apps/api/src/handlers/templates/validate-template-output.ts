import { Result } from "better-result";

import { scanFile } from "@/api/lib/file-scan/scan";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const isTemplateOutputValid = async ({
  buffer,
  fileName,
}: {
  buffer: Uint8Array;
  fileName: string;
}): Promise<boolean> => {
  const scanned = await scanFile({
    buffer,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName,
  });
  return Result.isOk(scanned) && scanned.value.verdict === "pass";
};
