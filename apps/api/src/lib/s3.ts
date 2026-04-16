import { S3Client } from "bun";

import { envBase } from "@/api/env-base";
import { contentDisposition } from "@/api/lib/content-disposition";

export const s3 = new S3Client({
  acl: "private",
  bucket: envBase.S3_BUCKET,
  endpoint: envBase.S3_ENDPOINT,
  region: envBase.S3_REGION,
  ...(envBase.S3_ACCESS_KEY_ID && envBase.S3_SECRET_ACCESS_KEY
    ? {
        accessKeyId: envBase.S3_ACCESS_KEY_ID,
        secretAccessKey: envBase.S3_SECRET_ACCESS_KEY,
      }
    : {}),
});

/**
 * Generate a presigned GET URL that forces the browser to
 * download the file instead of rendering it inline.
 *
 * Filenames are sanitized at upload time. RFC 6266 encoding
 * is applied here for non-ASCII characters.
 */
export const presignDownloadUrl = (
  key: string,
  options: { expiresIn: number; fileName: string },
) =>
  s3.presign(key, {
    expiresIn: options.expiresIn,
    method: "GET",
    contentDisposition: contentDisposition(options.fileName),
  });
