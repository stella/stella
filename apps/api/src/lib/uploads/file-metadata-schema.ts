import { t } from "elysia";

import { UPLOAD_FILE_MIN_BYTES } from "@stll/api-contract/limits";

import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

/** Declared size of an upload: at least one byte, at most `maximum`. */
export const tUploadFileSize = (maximum: number) =>
  t.Integer({
    minimum: UPLOAD_FILE_MIN_BYTES,
    // S3 enforces the maximum via the signed Content-Length; finalize
    // re-checks via S3.HEAD. Pinning it at the schema level lets the API
    // refuse oversized requests before even minting a URL.
    maximum,
  });

/**
 * What a client declares about one file it is about to upload. The single
 * presign and the dropped-folder presign both validate files with these
 * fields, so a file one of them refuses the other refuses too.
 */
export const documentUploadFileFields = {
  name: tDefaultVarchar,
  mimeType: t.String({ minLength: 1, maxLength: 255 }),
  size: tUploadFileSize(FILE_SIZE_LIMIT_BYTES.document),
  // Lowercase hex, exactly 64 chars. The same format the legacy entity
  // upload stores at `fields.content.sha256Hex`.
  sha256Hex: t.RegExp(/^[0-9a-f]{64}$/u),
} as const;
