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
 * Base credential resolution is shared with the Bun client — both
 * routes call `resolveS3Credentials()`, so static env credentials,
 * ECS container credentials, and IMDSv2 fallback all behave
 * identically across the two SDKs. In AWS prod, client-visible
 * presigned URLs can then be issued through an STS session policy
 * scoped to one organization/workspace key prefix.
 */
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Result, TaggedError } from "better-result";

import { envBase } from "@/api/env-base";
import { contentDisposition } from "@/api/lib/content-disposition";
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
  /** Final S3 key the client will write to. */
  key: string;
  /** Lifetime of the signed URL in seconds. Keep short — finalize is fast. */
  expiresIn: number;
  /** MIME type the client declared and the API allowed. Signed; client must echo. */
  contentType: string;
  /** Exact byte length. Signed; client must echo. */
  contentLength: number;
  /** SHA-256 of the bytes. Base64-encoded per the `x-amz-checksum-sha256` API. */
  sha256Base64: string;
  scope?: S3SigningScope;
  tagAsTemporaryUpload?: boolean;
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

const isAwsS3Endpoint = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host.includes("s3") && host.endsWith(".amazonaws.com");
  } catch {
    return false;
  }
};

type CachedClient = { client: AwsS3Client; createdAt: number };
type CachedScopedClient = { client: AwsS3Client; expiresAt: number };
export type S3SigningScope = {
  organizationId: string;
  workspaceId?: string | null;
};
type S3SigningAction = "s3:GetObject" | "s3:PutObject" | "s3:PutObjectTagging";
type KmsSigningAction = "kms:Decrypt" | "kms:GenerateDataKey";

let _clientPromise: Promise<CachedClient> | null = null;
let _stsClientPromise: Promise<STSClient> | null = null;
let _scopedClientPromises = new Map<string, Promise<CachedScopedClient>>();
const CLIENT_MAX_AGE_MS = 50 * 60 * 1000;
const SCOPED_SESSION_SECONDS = 900;
const SCOPED_CLIENT_REFRESH_SKEW_MS = 60 * 1000;
const TEMP_UPLOAD_TAG_KEY = "stella-upload-stage";
const TEMP_UPLOAD_TAG_VALUE = "tmp";
const TEMP_UPLOAD_TAGGING = `${TEMP_UPLOAD_TAG_KEY}=${TEMP_UPLOAD_TAG_VALUE}`;

const buildAwsS3Client = async (): Promise<CachedClient> => {
  const creds = await resolveS3Credentials();
  const client = new AwsS3Client({
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
  return { client, createdAt: Date.now() };
};

const buildStsClient = async (): Promise<STSClient> => {
  const creds = await resolveS3Credentials();
  return new STSClient({
    region: envBase.S3_REGION,
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
 * Lazily-built SDK v3 client, cached as a Promise so concurrent
 * callers that arrive while the first build is in flight share the
 * same client instead of each kicking off their own credential
 * resolution. Recycled every 50 minutes so STS session tokens are
 * refreshed before they expire — mirrors Bun's `getS3()` lifecycle
 * so both clients share the same credential horizon.
 */
const getAwsS3Client = async (): Promise<AwsS3Client> => {
  if (_clientPromise) {
    const cached = await _clientPromise;
    if (Date.now() - cached.createdAt < CLIENT_MAX_AGE_MS) {
      return cached.client;
    }
  }
  _clientPromise = buildAwsS3Client();
  const built = await _clientPromise;
  return built.client;
};

const getStsClient = async (): Promise<STSClient> => {
  _stsClientPromise ??= buildStsClient();
  return await _stsClientPromise;
};

const shouldUseScopedSigning = (): boolean =>
  !!envBase.S3_SCOPED_SIGNING_ROLE_ARN && isAwsS3Endpoint(envBase.S3_ENDPOINT);

const s3SigningScopePrefix = ({
  organizationId,
  workspaceId,
}: S3SigningScope): string =>
  workspaceId ? `${organizationId}/${workspaceId}/` : `${organizationId}/`;

export const isS3KeyInSigningScope = (
  key: string,
  scope: S3SigningScope,
): boolean => key.startsWith(s3SigningScopePrefix(scope));

const roleSessionName = (scope: S3SigningScope): string => {
  const scopeHash = new Bun.CryptoHasher("sha256")
    .update(s3SigningScopePrefix(scope))
    .digest("hex")
    .slice(0, 24);
  return `s3-scope-${scopeHash}`;
};

const scopedSessionPolicy = (
  scope: S3SigningScope,
  actions: readonly S3SigningAction[],
): string => {
  const kmsActions = kmsSigningActionsForS3Actions(actions);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: actions,
        Resource: `arn:aws:s3:::${envBase.S3_BUCKET}/${s3SigningScopePrefix(scope)}*`,
      },
      ...(kmsActions.length > 0
        ? [
            {
              Effect: "Allow",
              Action: kmsActions,
              Resource: "*",
              Condition: {
                StringEquals: {
                  "kms:ViaService": `s3.${envBase.S3_REGION}.amazonaws.com`,
                },
              },
            },
          ]
        : []),
    ],
  });
};

const kmsSigningActionsForS3Actions = (
  actions: readonly S3SigningAction[],
): KmsSigningAction[] => {
  const kmsActions: KmsSigningAction[] = [];
  if (actions.includes("s3:GetObject")) {
    kmsActions.push("kms:Decrypt");
  }
  if (actions.includes("s3:PutObject")) {
    kmsActions.push("kms:GenerateDataKey");
  }
  return kmsActions;
};

const scopedClientCacheKey = (
  scope: S3SigningScope,
  actions: readonly S3SigningAction[],
): string => `${s3SigningScopePrefix(scope)}|${[...actions].sort().join(",")}`;

const buildScopedAwsS3Client = async (
  scope: S3SigningScope,
  actions: readonly S3SigningAction[],
): Promise<CachedScopedClient> => {
  const roleArn = envBase.S3_SCOPED_SIGNING_ROLE_ARN;
  if (!roleArn) {
    throw new S3PresignError({
      message: "Scoped S3 signing role ARN is not configured",
    });
  }

  const sts = await getStsClient();
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: roleSessionName(scope),
      DurationSeconds: SCOPED_SESSION_SECONDS,
      Policy: scopedSessionPolicy(scope, actions),
    }),
  );
  const credentials = assumed.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new S3PresignError({
      message: "STS returned incomplete scoped S3 credentials",
    });
  }

  const client = new AwsS3Client({
    region: envBase.S3_REGION,
    endpoint: envBase.S3_ENDPOINT,
    forcePathStyle: isPathStyleRequired(envBase.S3_ENDPOINT),
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });

  return {
    client,
    expiresAt:
      credentials.Expiration?.getTime() ??
      Date.now() + SCOPED_SESSION_SECONDS * 1000,
  };
};

const getScopedAwsS3Client = async (
  scope: S3SigningScope,
  actions: readonly S3SigningAction[],
): Promise<AwsS3Client> => {
  const cacheKey = scopedClientCacheKey(scope, actions);
  const existingPromise = _scopedClientPromises.get(cacheKey);
  if (existingPromise) {
    const cached = await existingPromise;
    if (cached.expiresAt - Date.now() > SCOPED_CLIENT_REFRESH_SKEW_MS) {
      return cached.client;
    }
  }

  const nextPromise = buildScopedAwsS3Client(scope, actions);
  _scopedClientPromises.set(cacheKey, nextPromise);
  const built = await nextPromise;
  return built.client;
};

const getPresignClient = async ({
  actions,
  key,
  scope,
}: {
  actions: readonly S3SigningAction[];
  key: string;
  scope: S3SigningScope | undefined;
}): Promise<AwsS3Client> => {
  if (!shouldUseScopedSigning()) {
    return await getAwsS3Client();
  }

  if (!scope) {
    return await getAwsS3Client();
  }

  if (!isS3KeyInSigningScope(key, scope)) {
    throw new S3PresignError({
      message: "S3 key is outside the requested signing scope",
    });
  }

  return await getScopedAwsS3Client(scope, actions);
};

/** Reset the cached client. Test seam; not used in prod. */
export const resetAwsS3ClientForTesting = (): void => {
  _clientPromise = null;
  _stsClientPromise = null;
  _scopedClientPromises = new Map();
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
  scope,
  tagAsTemporaryUpload = false,
}: PresignUploadOptions): Promise<
  Result<PresignUploadResult, S3PresignError>
> =>
  await Result.tryPromise({
    try: async () => {
      const client = await getPresignClient({
        key,
        scope,
        actions: tagAsTemporaryUpload
          ? ["s3:PutObject", "s3:PutObjectTagging"]
          : ["s3:PutObject"],
      });
      const command = new PutObjectCommand({
        Bucket: envBase.S3_BUCKET,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
        ChecksumSHA256: sha256Base64,
        ChecksumAlgorithm: "SHA256",
        ...(tagAsTemporaryUpload ? { Tagging: TEMP_UPLOAD_TAGGING } : {}),
      });

      // SDK v3 hoists `x-amz-*` headers into the query string by
      // default when presigning. The SigV4 signature covers the
      // whole query string, so a hoisted header still can't be
      // tampered with — but a hoisted header doesn't *force* the
      // client to send the matching header to S3, and S3 only
      // verifies the body against `x-amz-checksum-sha256` when it
      // arrives as a request header. Without that, a client could
      // upload bytes that don't match the checksum and S3 would
      // silently accept them, breaking the integrity gate that
      // finalize relies on. `unhoistableHeaders` keeps the checksum
      // pair in the request-header list and `signableHeaders`
      // forces them into `X-Amz-SignedHeaders` so the client is
      // required to send them with the exact values the API
      // committed to. `signableHeaders` for `content-type` and
      // `content-length` pins those too.
      const url = await getSignedUrl(client, command, {
        expiresIn,
        signableHeaders: new Set([
          "content-type",
          "content-length",
          "x-amz-checksum-sha256",
          "x-amz-sdk-checksum-algorithm",
        ]),
        unhoistableHeaders: new Set([
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

export type PresignDownloadOptions = {
  expiresIn: number;
  fileName?: string;
  scope?: S3SigningScope;
};

export const presignDownloadUrl = async (
  key: string,
  { expiresIn, fileName, scope }: PresignDownloadOptions,
): Promise<string> => {
  const result = await Result.tryPromise({
    try: async () => {
      const client = await getPresignClient({
        key,
        scope,
        actions: ["s3:GetObject"],
      });
      return await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: envBase.S3_BUCKET,
          Key: key,
          ...(fileName
            ? { ResponseContentDisposition: contentDisposition(fileName) }
            : {}),
        }),
        { expiresIn },
      );
    },
    catch: (cause) =>
      new S3PresignError({
        message: "Failed to generate presigned download URL",
        cause,
      }),
  });

  if (Result.isError(result)) {
    throw result.error;
  }

  return result.value;
};

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
 * staged upload object to its final workspace key without
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
          // Staged uploads carry a lifecycle tag; durable objects must not.
          TaggingDirective: "REPLACE",
        }),
      );
    },
    catch: (cause) =>
      new S3PresignError({
        message: "Failed to copy object",
        cause,
      }),
  });
