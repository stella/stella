import { S3Client } from "bun";

import { env } from "@/api/env";
import { contentDisposition } from "@/api/lib/content-disposition";

export const s3 = new S3Client({
  acl: "private",
  bucket: env.S3_BUCKET,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  region: env.S3_REGION,
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
