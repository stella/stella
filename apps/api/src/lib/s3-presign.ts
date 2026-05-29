/**
 * AWS SDK v3 wrapper for presigned PUT uploads and the matching
 * post-upload verification calls.
 *
 * Bun's built-in `S3Client` (used everywhere else in this codebase,
 * see `apps/api/src/lib/s3.ts`) can presign GET URLs and content-type
 * but does not expose a way to sign `Content-Length`, the
 * `x-amz-checksum-sha256` integrity header, or read back the
 * checksum on `HeadObject`. SigV4 signing of those headers is the
 * critical security assumption of the presigned-upload migration
 * (see stella-infra issue #184): the URL binds the upload to an
 * exact size and an exact SHA-256, so a leaked URL within the
 * 5-minute expiry window cannot be reused to upload a different
 * payload or a different size.
 *
 * Credential resolution is shared with the Bun client — both
 * routes call `resolveS3Credentials()`, so static env credentials,
 * ECS container credentials, and IMDSv2 fallback all behave
 * identically across the two SDKs.
 */
import {
  CopyObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Result, TaggedError } from "better-result";

import { envBase } from "@/api/env-base";
import { resolveS3Credentials } from "@/api/lib/s3";

export class S3PresignError extends TaggedError("S3PresignError")<{
  message: string;
  cause?: unknown;
}>() {}

/**
 * Headers the API mandates the client must send when PUTting the
 * presigned URL. The SDK signs each of these so S3 rejects requests
 * that omit or rewrite them. Returned alongside the URL so the
 * client can attach them verbatim.
 */
export type PresignedUploadHeaders = {
  "content-type": string;
  "content-length": string;
  "x-amz-checksum-sha256": string;
  "x-amz-sdk-checksum-algorithm": "SHA256";
};

export type PresignUploadOptions = {
  /** Final S3 key the client will write to (caller chooses; usually `tmp/{uploadId}`). */
  key: string;
  /** Lifetime of the signed URL in seconds. Keep short — finalize is fast. */
  expiresIn: number;
  /** MIME type the client declared and the API allowed. Signed; client must echo. */
  contentType: string;
  /** Exact byte length. Signed; client must echo. */
  contentLength: number;
  /** SHA-256 of the bytes. Base64-encoded per the `x-amz-checksum-sha256` API. */
  sha256Base64: string;
};

export type PresignUploadResult = {
  url: string;
  headers: PresignedUploadHeaders;
};

/**
 * S3 endpoints that aren't `*.amazonaws.com` (MinIO, R2, etc.)
 * almost always need path-style addressing — the bucket lives
 * under the path, not as a subdomain. AWS itself supports both
 * but virtual-hosted-style is the default and faster.
 */
const isPathStyleRequired = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return !(host.includes("s3") && host.endsWith(".amazonaws.com"));
  } catch {
    return true;
  }
};

let _awsClient: AwsS3Client | null = null;
let _awsClientCreatedAt = 0;
const CLIENT_MAX_AGE_MS = 50 * 60 * 1000;

const buildAwsS3Client = async (): Promise<AwsS3Client> => {
  const creds = await resolveS3Credentials();
  return new AwsS3Client({
    region: envBase.S3_REGION,
    endpoint: envBase.S3_ENDPOINT,
    forcePathStyle: isPathStyleRequired(envBase.S3_ENDPOINT),
    ...(creds
      ? {
          credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
          },
        }
      : {}),
  });
};

/**
 * Lazily-built SDK v3 client. Recycled every 50 minutes so STS
 * session tokens are refreshed before they expire. The wrapper
 * mirrors the lifecycle of Bun's `getS3()` so both clients share
 * the same credential horizon.
 */
const getAwsS3Client = async (): Promise<AwsS3Client> => {
  if (_awsClient && Date.now() - _awsClientCreatedAt < CLIENT_MAX_AGE_MS) {
    return _awsClient;
  }
  _awsClient = await buildAwsS3Client();
  _awsClientCreatedAt = Date.now();
  return _awsClient;
};

/** Reset the cached client. Test seam; not used in prod. */
export const resetAwsS3ClientForTesting = (): void => {
  _awsClient = null;
  _awsClientCreatedAt = 0;
};

/**
 * Generate a presigned PUT URL bound to a specific object and an
 * exact set of headers. The returned `headers` map MUST be sent
 * verbatim by the client; deviating from any signed header makes
 * S3 reject the upload with `403 SignatureDoesNotMatch`.
 */
export const presignUploadUrl = async ({
  key,
  expiresIn,
  contentType,
  contentLength,
  sha256Base64,
}: PresignUploadOptions): Promise<
  Result<PresignUploadResult, S3PresignError>
> =>
  await Result.tryPromise({
    try: async () => {
      const client = await getAwsS3Client();
      const command = new PutObjectCommand({
        Bucket: envBase.S3_BUCKET,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
        ChecksumSHA256: sha256Base64,
        ChecksumAlgorithm: "SHA256",
      });

      const url = await getSignedUrl(client, command, {
        expiresIn,
        // Pin the headers into the signature. Without this, S3 ignores
        // the values the client sends — defeating the integrity gate.
        signableHeaders: new Set([
          "content-type",
          "content-length",
          "x-amz-checksum-sha256",
          "x-amz-sdk-checksum-algorithm",
        ]),
      });

      const headers: PresignedUploadHeaders = {
        "content-type": contentType,
        "content-length": String(contentLength),
        "x-amz-checksum-sha256": sha256Base64,
        "x-amz-sdk-checksum-algorithm": "SHA256",
      };

      return { url, headers };
    },
    catch: (cause) =>
      new S3PresignError({
        message: "Failed to generate presigned upload URL",
        cause,
      }),
  });

export type HeadObjectResult = {
  /** Size in bytes as reported by S3 (after the upload completed). */
  contentLength: number;
  /** Base64 SHA-256 stored on the object, if it was uploaded with one. */
  checksumSHA256: string | null;
};

/**
 * Read an object's actual size and stored SHA-256 from S3. Used by
 * the finalize handler to verify the client uploaded what they
 * said they would. The checksum is only present when the upload
 * was made with `x-amz-checksum-sha256` and the client requested
 * checksum mode — both of which the presign helper above enforces.
 */
export const headObject = async (
  key: string,
): Promise<Result<HeadObjectResult, S3PresignError>> =>
  await Result.tryPromise({
    try: async () => {
      const client = await getAwsS3Client();
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: envBase.S3_BUCKET,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      return {
        contentLength: response.ContentLength ?? 0,
        checksumSHA256: response.ChecksumSHA256 ?? null,
      };
    },
    catch: (cause) =>
      new S3PresignError({
        message: "Failed to head object",
        cause,
      }),
  });

/**
 * Server-side CopyObject. Used by finalize to promote a scanned
 * `tmp/{uploadId}` object to its final workspace key without
 * pulling bytes through the API task. We prefer this over Bun's
 * `write(target, file(source))` for promotion specifically
 * because the SDK v3 path is documented as a server-side copy;
 * Bun's behaviour for that signature is not promised by its types.
 */
export const copyObject = async (
  sourceKey: string,
  destKey: string,
): Promise<Result<void, S3PresignError>> =>
  await Result.tryPromise({
    try: async () => {
      const client = await getAwsS3Client();
      await client.send(
        new CopyObjectCommand({
          Bucket: envBase.S3_BUCKET,
          // CopySource needs the bucket prefix and URL-encoded key.
          CopySource: `${envBase.S3_BUCKET}/${encodeURIComponent(sourceKey)}`,
          Key: destKey,
        }),
      );
    },
    catch: (cause) =>
      new S3PresignError({
        message: "Failed to copy object",
        cause,
      }),
  });
