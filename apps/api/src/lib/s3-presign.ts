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
import { detached } from "@/api/lib/detached";
import { resolveS3Credentials } from "@/api/lib/s3";
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

export class S3PresignError extends TaggedError("S3PresignError")<{
  message: string;
  cause?: unknown;
}> {}

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
  "x-amz-tagging"?: string;
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
 * S3 endpoints that aren't `*.amazonaws.com` (RustFS, R2, etc.)
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
type CachedStsClient = { client: STSClient; createdAt: number };
type CachedScopedClient = { client: AwsS3Client; expiresAt: number };
type ScopedClientCacheEntry = {
  cached?: CachedScopedClient;
  promise: Promise<CachedScopedClient>;
};
export const S3_SIGNING_KEYSPACES = ["tenant", "exports"] as const;
export type S3SigningKeyspace = (typeof S3_SIGNING_KEYSPACES)[number];

export type S3SigningScope = {
  keyspace?: S3SigningKeyspace;
  organizationId: string;
  workspaceId?: string | null;
};
type S3SigningAction = "s3:GetObject" | "s3:PutObject" | "s3:PutObjectTagging";
type KmsSigningAction = "kms:Decrypt" | "kms:GenerateDataKey";

let _clientPromise: Promise<CachedClient> | null = null;
let _stsClientPromise: Promise<CachedStsClient> | null = null;
let _scopedClientCache = new Map<string, ScopedClientCacheEntry>();
const CLIENT_MAX_AGE_MS = 50 * 60 * 1000;
const SCOPED_SESSION_SECONDS = 3600;
const SCOPED_CLIENT_REFRESH_SKEW_MS = 60 * 1000;
/** Bound the process-wide STS client cache across organizations/workspaces. */
export const SCOPED_CLIENT_CACHE_MAX_ENTRIES = 256;
const AWS_SDK_REQUEST_TIMEOUT_MS = 30_000;
const TEMP_UPLOAD_TAG_KEY = "stella-upload-stage";
const TEMP_UPLOAD_TAG_VALUE = "tmp";
const TEMP_UPLOAD_TAGGING = `${TEMP_UPLOAD_TAG_KEY}=${TEMP_UPLOAD_TAG_VALUE}`;
const S3_GET_OBJECT_ACTION = "s3:GetObject" as const;

// Set only by `configureS3PresignForTesting`; production always uses the env.
let _endpointOverride: string | null = null;
const s3Endpoint = (): string => _endpointOverride ?? envBase.S3_ENDPOINT;

const buildAwsS3Client = async (): Promise<CachedClient> => {
  const creds = await resolveS3Credentials();
  const client = new AwsS3Client({
    region: envBase.S3_REGION,
    endpoint: s3Endpoint(),
    forcePathStyle: isPathStyleRequired(s3Endpoint()),
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

const buildStsClient = async (): Promise<CachedStsClient> => {
  const creds = await resolveS3Credentials();
  const client = new STSClient({
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
  return { client, createdAt: Date.now() };
};

/**
 * Lazily-built SDK v3 client, cached as a Promise so concurrent
 * callers that arrive while the first build is in flight share the
 * same client instead of each kicking off their own credential
 * resolution. Recycled every 50 minutes so STS session tokens are
 * refreshed before they expire — mirrors Bun's `getS3()` lifecycle
 * so both clients share the same credential horizon.
 *
 * A failed build clears the slot: credential resolution reaches the
 * network, so caching its rejection would replay one transient
 * failure to every later caller for the life of the process.
 */
const getAwsS3Client = async (): Promise<AwsS3Client> => {
  if (_clientPromise) {
    const cached = await _clientPromise;
    if (Date.now() - cached.createdAt < CLIENT_MAX_AGE_MS) {
      return cached.client;
    }
  }
  const nextPromise = buildAwsS3Client().catch((error: unknown) => {
    if (_clientPromise === nextPromise) {
      _clientPromise = null;
    }
    throw error;
  });
  _clientPromise = nextPromise;
  const built = await nextPromise;
  return built.client;
};

const getStsClient = async (): Promise<STSClient> => {
  if (_stsClientPromise) {
    const cached = await _stsClientPromise;
    if (Date.now() - cached.createdAt < CLIENT_MAX_AGE_MS) {
      return cached.client;
    }
  }

  const nextPromise = buildStsClient().catch((error: unknown) => {
    if (_stsClientPromise === nextPromise) {
      _stsClientPromise = null;
    }
    throw error;
  });
  _stsClientPromise = nextPromise;
  const built = await nextPromise;
  return built.client;
};

const shouldUseScopedSigning = (): boolean =>
  !!envBase.S3_SCOPED_SIGNING_ROLE_ARN && isAwsS3Endpoint(envBase.S3_ENDPOINT);
let isScopedSigningEnabled = shouldUseScopedSigning;

const s3SigningScopePrefix = ({
  keyspace = "tenant",
  organizationId,
  workspaceId,
}: S3SigningScope): string => {
  const tenantPrefix = workspaceId
    ? `${organizationId}/${workspaceId}/`
    : `${organizationId}/`;
  return keyspace === "exports" ? `exports/${tenantPrefix}` : tenantPrefix;
};

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
): string => `${s3SigningScopePrefix(scope)}|${actions.toSorted().join(",")}`;

export const hasScopedSessionTimeForPresign = ({
  expiresAt,
  expiresIn,
  now = Date.now(),
}: {
  expiresAt: number;
  expiresIn: number;
  now?: number;
}): boolean =>
  expiresAt - now > expiresIn * 1000 + SCOPED_CLIENT_REFRESH_SKEW_MS;

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
    { abortSignal: AbortSignal.timeout(AWS_SDK_REQUEST_TIMEOUT_MS) },
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
    endpoint: s3Endpoint(),
    forcePathStyle: isPathStyleRequired(s3Endpoint()),
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

export type ScopedS3ClientFactory = typeof buildScopedAwsS3Client;
let scopedS3ClientFactory: ScopedS3ClientFactory = buildScopedAwsS3Client;

const disposeScopedClient = (entry: ScopedClientCacheEntry): void => {
  detached(
    entry.promise.then(({ client }) => client.destroy()),
    "s3-presign.dispose-scoped-client",
  );
};

const removeScopedClient = (
  cacheKey: string,
  entry: ScopedClientCacheEntry,
): void => {
  if (_scopedClientCache.get(cacheKey) !== entry) {
    return;
  }
  _scopedClientCache.delete(cacheKey);
  disposeScopedClient(entry);
};

/** Remove expired entries and enforce least-recently-used capacity. */
const pruneScopedClientCache = (): void => {
  for (const [cacheKey, entry] of _scopedClientCache) {
    if (
      entry.cached &&
      !hasScopedSessionTimeForPresign({
        expiresAt: entry.cached.expiresAt,
        expiresIn: 0,
      })
    ) {
      removeScopedClient(cacheKey, entry);
    }
  }

  while (_scopedClientCache.size > SCOPED_CLIENT_CACHE_MAX_ENTRIES) {
    const leastRecentlyUsed = _scopedClientCache.entries().next().value;
    if (!leastRecentlyUsed) {
      return;
    }
    const [cacheKey, entry] = leastRecentlyUsed;
    removeScopedClient(cacheKey, entry);
  }
};

const touchScopedClient = (
  cacheKey: string,
  entry: ScopedClientCacheEntry,
): void => {
  _scopedClientCache.delete(cacheKey);
  _scopedClientCache.set(cacheKey, entry);
};

const getScopedAwsS3Client = async (
  scope: S3SigningScope,
  actions: readonly S3SigningAction[],
  expiresIn: number,
): Promise<AwsS3Client> => {
  const cacheKey = scopedClientCacheKey(scope, actions);
  pruneScopedClientCache();
  const existing = _scopedClientCache.get(cacheKey);
  if (existing) {
    touchScopedClient(cacheKey, existing);
    let cached: CachedScopedClient;
    try {
      cached = await existing.promise;
    } catch (error) {
      removeScopedClient(cacheKey, existing);
      throw error;
    }
    if (
      hasScopedSessionTimeForPresign({ expiresAt: cached.expiresAt, expiresIn })
    ) {
      return cached.client;
    }
    removeScopedClient(cacheKey, existing);
  }

  const entry: ScopedClientCacheEntry = {
    promise: scopedS3ClientFactory(scope, actions),
  };
  entry.promise = entry.promise.catch((error: unknown) => {
    removeScopedClient(cacheKey, entry);
    throw error;
  });
  detached(
    entry.promise.then((cached) => {
      entry.cached = cached;
      pruneScopedClientCache();
      return undefined;
    }),
    "s3-presign.cache-entry-settled",
  );
  _scopedClientCache.set(cacheKey, entry);
  pruneScopedClientCache();
  const built = await entry.promise;
  return built.client;
};

/** Test seam for cache lifecycle checks without enabling production STS mode. */
export const getScopedAwsS3ClientForTesting = async ({
  actions,
  expiresIn,
  scope,
}: {
  actions: readonly S3SigningAction[];
  expiresIn: number;
  scope: S3SigningScope;
}): Promise<AwsS3Client> =>
  await getScopedAwsS3Client(scope, actions, expiresIn);

/** Test seam for deterministic scoped-client factory and cache assertions. */
export const setScopedS3ClientFactoryForTesting = (
  factory: ScopedS3ClientFactory,
): void => {
  scopedS3ClientFactory = factory;
};

/** Test seam for scoped-signing paths without mutating process environment. */
export const setScopedSigningEnabledForTesting = (
  predicate: () => boolean,
): void => {
  isScopedSigningEnabled = predicate;
};

export const getScopedClientCacheSizeForTesting = (): number =>
  _scopedClientCache.size;

const getTenantAwsS3Client = async ({
  actions,
  key,
  scope,
}: {
  actions: readonly S3SigningAction[];
  key: string;
  scope: S3SigningScope;
}): Promise<AwsS3Client> => {
  if (!isS3KeyInSigningScope(key, scope)) {
    throw new S3PresignError({
      message: "S3 key is outside the requested signing scope",
    });
  }
  if (!isScopedSigningEnabled()) {
    return await getAwsS3Client();
  }
  return await getScopedAwsS3Client(scope, actions, 0);
};

type TenantS3OperationHooks = {
  resolveClient: typeof getTenantAwsS3Client;
  readObject: (
    client: AwsS3Client,
    command: GetObjectCommand,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  writeObject: (
    client: AwsS3Client,
    command: PutObjectCommand,
    signal: AbortSignal,
  ) => Promise<void>;
};

export const createTenantS3RequestSignal = (
  signal: AbortSignal,
  timeoutMs = AWS_SDK_REQUEST_TIMEOUT_MS,
): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

const DEFAULT_TENANT_S3_OPERATION_HOOKS: TenantS3OperationHooks = {
  resolveClient: getTenantAwsS3Client,
  readObject: async (client, command, signal) => {
    const response = await client.send(command, {
      abortSignal: createTenantS3RequestSignal(signal),
    });
    if (!response.Body) {
      throw new S3PresignError({
        message: "S3 returned an object without a response body",
      });
    }
    return await response.Body.transformToByteArray();
  },
  writeObject: async (client, command, signal) => {
    await client.send(command, {
      abortSignal: createTenantS3RequestSignal(signal),
    });
  },
};

let tenantS3OperationHooks = DEFAULT_TENANT_S3_OPERATION_HOOKS;

/** Replace tenant-object I/O seams for unit tests. */
export const setTenantS3OperationHooksForTesting = (
  hooks: TenantS3OperationHooks,
): void => {
  tenantS3OperationHooks = hooks;
};

/** Read an object after enforcing its organization/workspace key scope. */
export const readTenantS3ArrayBuffer = async ({
  key,
  scope,
  signal,
}: {
  key: string;
  scope: S3SigningScope;
  signal: AbortSignal;
}): Promise<ArrayBuffer> => {
  if (!isS3KeyInSigningScope(key, scope)) {
    throw new S3PresignError({
      message: "S3 key is outside the requested signing scope",
    });
  }
  const client = await tenantS3OperationHooks.resolveClient({
    actions: ["s3:GetObject"],
    key,
    scope,
  });
  const bytes = await tenantS3OperationHooks.readObject(
    client,
    new GetObjectCommand({ Bucket: envBase.S3_BUCKET, Key: key }),
    signal,
  );
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

/** Write an object after enforcing its organization/workspace key scope. */
export const writeTenantS3Object = async ({
  contentType,
  data,
  key,
  scope,
  signal,
}: {
  contentType: string;
  data: Uint8Array;
  key: string;
  scope: S3SigningScope;
  signal: AbortSignal;
}): Promise<void> => {
  if (!isS3KeyInSigningScope(key, scope)) {
    throw new S3PresignError({
      message: "S3 key is outside the requested signing scope",
    });
  }
  const client = await tenantS3OperationHooks.resolveClient({
    actions: ["s3:PutObject"],
    key,
    scope,
  });
  await tenantS3OperationHooks.writeObject(
    client,
    new PutObjectCommand({
      Body: data,
      Bucket: envBase.S3_BUCKET,
      ContentType: contentType,
      Key: key,
    }),
    signal,
  );
};

const getPresignClient = async ({
  actions,
  expiresIn,
  key,
  scope,
}: {
  actions: readonly S3SigningAction[];
  expiresIn: number;
  key: string;
  scope: S3SigningScope | undefined;
}): Promise<AwsS3Client> => {
  if (!isScopedSigningEnabled()) {
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

  return await getScopedAwsS3Client(scope, actions, expiresIn);
};

/**
 * Longest presign expiry the warmed session must be able to cover. Matches
 * the file-read expiry (`FILE_READ_URL_EXPIRY_SECONDS` in
 * handlers/files/get.ts): a warmed session passes
 * `hasScopedSessionTimeForPresign` for any presign up to this expiry.
 */
const PREWARM_PRESIGN_EXPIRES_IN_SECONDS = 15 * 60;

/**
 * Fire-and-forget warmup of a workspace's scoped download-signing session.
 *
 * Under scoped signing (AWS prod), the FIRST presign for a given
 * organization/workspace scope pays a full STS AssumeRole round trip, which
 * surfaced as a >1s TTFB tail on the first `GET /files/:id/url` after
 * opening a workspace. Warming the session when the workspace is activated
 * (see handlers/workspaces/update-active.ts) moves that round trip off the
 * file-open path; the session is then cached for ~1h like any other scoped
 * client. No-op when scoped signing is not configured. Callers run this
 * detached and capture failures as telemetry — the real presign path keeps
 * its own error handling either way.
 */
export const prewarmScopedDownloadSigning = async (
  scope: S3SigningScope,
): Promise<void> => {
  if (!isScopedSigningEnabled()) {
    return;
  }
  await getScopedAwsS3Client(
    scope,
    [S3_GET_OBJECT_ACTION],
    PREWARM_PRESIGN_EXPIRES_IN_SECONDS,
  );
};

/**
 * Test seam: point the SDK clients this module builds at `endpoint`, an
 * in-process store speaking the S3 wire protocol (see
 * `tests/helpers/fake-s3.ts`), so `copyObject` and `headObject` run for real
 * instead of being replaced by a module mock.
 */
export const configureS3PresignForTesting = ({
  endpoint,
}: {
  endpoint: string;
}): void => {
  _endpointOverride = endpoint;
  _clientPromise = null;
};

/** Reset the cached client. Test seam; not used in prod. */
export const resetAwsS3ClientForTesting = (): void => {
  _endpointOverride = null;
  _clientPromise = null;
  _stsClientPromise = null;
  for (const entry of _scopedClientCache.values()) {
    disposeScopedClient(entry);
  }
  _scopedClientCache = new Map();
  scopedS3ClientFactory = buildScopedAwsS3Client;
  isScopedSigningEnabled = shouldUseScopedSigning;
  tenantS3OperationHooks = DEFAULT_TENANT_S3_OPERATION_HOOKS;
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
        expiresIn,
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
          ...(tagAsTemporaryUpload ? ["x-amz-tagging"] : []),
        ]),
        unhoistableHeaders: new Set([
          "x-amz-checksum-sha256",
          "x-amz-sdk-checksum-algorithm",
          ...(tagAsTemporaryUpload ? ["x-amz-tagging"] : []),
        ]),
      });

      const headers: PresignedUploadHeaders = {
        "content-type": contentType,
        "content-length": String(contentLength),
        "x-amz-checksum-sha256": sha256Base64,
        "x-amz-sdk-checksum-algorithm": "SHA256",
        ...(tagAsTemporaryUpload
          ? { "x-amz-tagging": TEMP_UPLOAD_TAGGING }
          : {}),
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
        expiresIn,
        key,
        scope,
        actions: ["s3:GetObject"],
      });
      return await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: envBase.S3_BUCKET,
          Key: key,
          ResponseCacheControl:
            RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS["Cache-Control"],
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
        { abortSignal: AbortSignal.timeout(AWS_SDK_REQUEST_TIMEOUT_MS) },
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
 * Server-side documents-bucket copy without pulling bytes through the API
 * task. Upload finalization promotes a scanned staged object; workspace and
 * entity duplication create independently owned durable objects. We prefer
 * this documented SDK v3 primitive over Bun's `write(target, file(source))`,
 * whose copy behaviour is not promised by its types.
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
          Tagging: "",
        }),
        { abortSignal: AbortSignal.timeout(AWS_SDK_REQUEST_TIMEOUT_MS) },
      );
    },
    catch: (cause) =>
      new S3PresignError({
        message: "Failed to copy object",
        cause,
      }),
  });
