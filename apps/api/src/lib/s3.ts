import { S3Client } from "bun";

import { envBase } from "@/api/env-base";
import { contentDisposition } from "@/api/lib/content-disposition";

/**
 * Fetch temporary credentials from EC2 Instance Metadata
 * Service (IMDSv2). Bun's S3Client resolves credentials
 * from constructor options or AWS_* env vars but does NOT
 * query IMDS directly. On EC2, Docker injects stale
 * AWS_ACCESS_KEY_ID / AWS_SESSION_TOKEN env vars at
 * container start that expire after ~6 hours.
 *
 * Returns null when not running on EC2 (local dev).
 */
const fetchImdsCredentials = async (): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
} | null> => {
  try {
    const tokenResponse = await fetch(
      "http://169.254.169.254/latest/api/token",
      {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "300" },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!tokenResponse.ok) {
      return null;
    }
    const imdsToken = await tokenResponse.text();

    const roleResponse = await fetch(
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      {
        headers: { "X-aws-ec2-metadata-token": imdsToken },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!roleResponse.ok) {
      return null;
    }
    const roleName = (await roleResponse.text()).trim();

    const credsResponse = await fetch(
      `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`,
      {
        headers: { "X-aws-ec2-metadata-token": imdsToken },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!credsResponse.ok) {
      return null;
    }
    const creds: unknown = await credsResponse.json();
    if (
      typeof creds !== "object" ||
      creds === null ||
      !("AccessKeyId" in creds) ||
      !("SecretAccessKey" in creds) ||
      !("Token" in creds) ||
      typeof creds.AccessKeyId !== "string" ||
      typeof creds.SecretAccessKey !== "string" ||
      typeof creds.Token !== "string"
    ) {
      return null;
    }

    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.Token,
    };
  } catch {
    return null;
  }
};

const buildS3Client = (
  creds?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } | null,
): S3Client =>
  new S3Client({
    acl: "private",
    bucket: envBase.S3_BUCKET,
    endpoint: envBase.S3_ENDPOINT,
    region: envBase.S3_REGION,
    ...(creds
      ? {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
        }
      : {}),
  });

/**
 * Recreate the S3 client with fresh credentials. On EC2,
 * fetches from IMDS; locally, falls back to env vars / no
 * credentials (MinIO via S3_ENDPOINT).
 *
 * Call at process startup and periodically in long-running
 * processes to prevent STS credential expiry.
 */
export const refreshS3 = async (): Promise<void> => {
  if (envBase.S3_ACCESS_KEY_ID && envBase.S3_SECRET_ACCESS_KEY) {
    _client = buildS3Client({
      accessKeyId: envBase.S3_ACCESS_KEY_ID,
      secretAccessKey: envBase.S3_SECRET_ACCESS_KEY,
    });
  } else {
    // Bun's S3Client reads AWS_* env vars at the libc level,
    // not through process.env. Overwrite them with fresh IMDS
    // credentials so both the constructor AND env-var path use
    // valid credentials.
    const imdsCreds = await fetchImdsCredentials();
    if (imdsCreds) {
      process.env.AWS_ACCESS_KEY_ID = imdsCreds.accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = imdsCreds.secretAccessKey;
      process.env.AWS_SESSION_TOKEN = imdsCreds.sessionToken;
    }
    _client = buildS3Client(imdsCreds);
  }
  _clientCreatedAt = Date.now();
};

const CREDENTIAL_MAX_AGE_MS = 50 * 60 * 1000;
let _client: S3Client = buildS3Client(
  envBase.S3_ACCESS_KEY_ID && envBase.S3_SECRET_ACCESS_KEY
    ? {
        accessKeyId: envBase.S3_ACCESS_KEY_ID,
        secretAccessKey: envBase.S3_SECRET_ACCESS_KEY,
      }
    : null,
);
let _clientCreatedAt = Date.now();

/** Returns the current S3 client (synchronous). */
export const getS3 = (): S3Client => _client;

/** True when credentials are older than 50 minutes. */
export const isS3Stale = (): boolean =>
  Date.now() - _clientCreatedAt > CREDENTIAL_MAX_AGE_MS;

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
