import { S3Client } from "bun";

import { envBase } from "@/api/env-base";
import { contentDisposition } from "@/api/lib/content-disposition";

const createS3Client = (): S3Client =>
  new S3Client({
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
 * Bun's S3Client caches credentials from EC2 instance metadata
 * (IMDS) at construction and does not auto-refresh them. In
 * long-running processes (ingestion daemon), the STS token
 * expires after ~6 hours. Recreating the client every 50
 * minutes ensures fresh credentials without hammering IMDS.
 */
const CREDENTIAL_MAX_AGE_MS = 50 * 60 * 1000;
let _client: S3Client | null = null;
let _clientCreatedAt = 0;

export const getS3 = (): S3Client => {
  if (!_client || Date.now() - _clientCreatedAt > CREDENTIAL_MAX_AGE_MS) {
    _client = createS3Client();
    _clientCreatedAt = Date.now();
  }
  return _client;
};

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
  getS3().presign(key, {
    expiresIn: options.expiresIn,
    method: "GET",
    contentDisposition: contentDisposition(options.fileName),
  });
