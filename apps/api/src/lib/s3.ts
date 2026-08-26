import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import { panic, Result, TaggedError } from "better-result";
import { S3Client } from "bun";

import { envBase } from "@/api/env-base";
import { contentDisposition } from "@/api/lib/content-disposition";
import { errorTag, safeErrorCode } from "@/api/lib/errors/utils";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { logger } from "@/api/lib/observability/logger";
import {
  credentialsFromEnvValues,
  type OptionalS3Credentials,
} from "@/api/lib/s3-credentials";
import { isRecord } from "@/api/lib/type-guards";
import { withTimeout } from "@/api/lib/with-timeout";

type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

type CredentialRuntimeEnv = Record<string, string | undefined>;
type Fetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;
type S3CredentialsProvider = "auto" | "env" | "aws-runtime" | "none";

const ECS_CREDENTIALS_BASE_URL = "http://169.254.170.2";

const isCredentialsShape = (
  value: unknown,
): value is {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
} =>
  typeof value === "object" &&
  value !== null &&
  "AccessKeyId" in value &&
  "SecretAccessKey" in value &&
  "Token" in value &&
  typeof value.AccessKeyId === "string" &&
  typeof value.SecretAccessKey === "string" &&
  typeof value.Token === "string";

const fetchCredentialJson = async (
  url: string,
  {
    fetchImpl,
    headers,
  }: {
    fetchImpl: Fetcher;
    headers?: Record<string, string>;
  },
): Promise<S3Credentials | null> => {
  try {
    const response = await fetchImpl(url, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      return null;
    }

    const creds: unknown = await response.json();
    if (!isCredentialsShape(creds)) {
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

/**
 * The container credential endpoint this runtime is configured to use, or null
 * when it is not configured or the configuration is unusable.
 *
 * A URL here means a task role is intended and reachable, which is what makes
 * an IMDS fallback a widening rather than a retry. A malformed URI returns null
 * and keeps its long-standing "ignore and carry on" behaviour.
 */
const containerCredentialsUrl = (
  runtimeEnv: CredentialRuntimeEnv,
): string | null => {
  const relativeUri = runtimeEnv["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  const fullUri = runtimeEnv["AWS_CONTAINER_CREDENTIALS_FULL_URI"];

  if (relativeUri) {
    if (!relativeUri.startsWith("/")) {
      return null;
    }
    return `${ECS_CREDENTIALS_BASE_URL}${relativeUri}`;
  }

  if (!fullUri) {
    return null;
  }

  try {
    const parsedUrl = new URL(fullUri);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
};

const fetchEcsCredentials = async ({
  fetchImpl = fetch,
  runtimeEnv = process.env,
}: {
  fetchImpl?: Fetcher;
  runtimeEnv?: CredentialRuntimeEnv;
} = {}): Promise<S3Credentials | null> => {
  const url = containerCredentialsUrl(runtimeEnv);
  if (!url) {
    return null;
  }

  const headers: Record<string, string> = {};
  const authorizationToken = runtimeEnv["AWS_CONTAINER_AUTHORIZATION_TOKEN"];
  const authorizationTokenFile =
    runtimeEnv["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"];

  if (authorizationToken) {
    headers["Authorization"] = authorizationToken;
  } else if (authorizationTokenFile) {
    // The token file is configured, so an unreadable one is a
    // misconfiguration, not an optional read. Sending the credential request
    // without the header can only fail at the endpoint, several layers away
    // from the cause; report it here and let the caller fall through to the
    // next credential source.
    const token = await Result.tryPromise(
      async () => await Bun.file(authorizationTokenFile).text(),
    );
    if (token.isErr()) {
      logger.warn("s3.container_credentials_token_unreadable", {
        "error.type": errorTag(token.error),
      });
      return null;
    }
    headers["Authorization"] = token.value.trim();
  }

  return await fetchCredentialJson(url, { fetchImpl, headers });
};

/**
 * Fetch temporary credentials from EC2 Instance Metadata
 * Service (IMDSv2). Bun's S3Client resolves credentials
 * from constructor options or AWS_* env vars but does NOT
 * query IMDS directly.
 *
 * Returns null when not running on EC2 (local dev).
 */
const fetchImdsCredentials = async ({
  fetchImpl = fetch,
}: {
  fetchImpl?: Fetcher;
} = {}): Promise<S3Credentials | null> => {
  try {
    const tokenResponse = await fetchImpl(
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

    const roleResponse = await fetchImpl(
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

    const credsResponse = await fetchImpl(
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
    if (!isCredentialsShape(creds)) {
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
  bucket: string,
  creds?: OptionalS3Credentials | null,
): S3Client =>
  new S3Client({
    acl: "private",
    bucket,
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

const isPathStyleRequired = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return !(host.includes("s3") && host.endsWith(".amazonaws.com"));
  } catch {
    return true;
  }
};

const buildAbortableS3Client = (
  creds?: OptionalS3Credentials | null,
): AwsS3Client =>
  new AwsS3Client({
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

/** The legal-corpus bucket; falls back to the default bucket in dev. */
const corpusBucket = (): string =>
  envBase.LEGAL_CORPUS_S3_BUCKET ?? envBase.S3_BUCKET;

type ResolveS3CredentialsOptions = {
  endpoint?: string;
  fetchImpl?: Fetcher;
  provider?: S3CredentialsProvider;
  runtimeEnv?: CredentialRuntimeEnv;
  staticCredentials?: OptionalS3Credentials | null;
};

const staticCredentialsFromEnv = (): OptionalS3Credentials | null =>
  credentialsFromEnvValues(
    envBase.S3_ACCESS_KEY_ID,
    envBase.S3_SECRET_ACCESS_KEY,
  );

const isAwsS3Endpoint = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host.includes("s3") && host.endsWith(".amazonaws.com");
  } catch {
    return false;
  }
};

const resolveAwsRuntimeCredentials = async (
  fetchImpl: Fetcher,
  runtimeEnv: CredentialRuntimeEnv,
): Promise<S3Credentials | null> => {
  const ecsCredentials = await fetchEcsCredentials({ fetchImpl, runtimeEnv });
  if (ecsCredentials) {
    return ecsCredentials;
  }

  // A task configured for container credentials does not fall through to the
  // instance role. IMDS answers with the EC2 instance's role, which on ECS is
  // the host's and is routinely broader than the task's, so treating an
  // unreadable token file or a failed container request as "try the next
  // source" would quietly widen the credentials the process runs under. No
  // container configuration means no such boundary to cross, and IMDS is then
  // the ordinary next source.
  if (containerCredentialsUrl(runtimeEnv)) {
    logger.warn("s3.container_credentials_unavailable", {
      "fallback.suppressed": "imds",
    });
    return null;
  }

  const imdsCredentials = await fetchImdsCredentials({ fetchImpl });
  if (imdsCredentials) {
    return imdsCredentials;
  }

  return null;
};

export const resolveS3Credentials = async ({
  endpoint = envBase.S3_ENDPOINT,
  fetchImpl = fetch,
  provider = envBase.S3_CREDENTIALS_PROVIDER,
  runtimeEnv = process.env,
  staticCredentials = staticCredentialsFromEnv(),
}: ResolveS3CredentialsOptions = {}): Promise<OptionalS3Credentials | null> => {
  if (provider === "none") {
    return null;
  }

  if (provider === "env") {
    return staticCredentials;
  }

  if (provider === "aws-runtime") {
    return await resolveAwsRuntimeCredentials(fetchImpl, runtimeEnv);
  }

  if (!isAwsS3Endpoint(endpoint)) {
    return (
      staticCredentials ??
      (await resolveAwsRuntimeCredentials(fetchImpl, runtimeEnv))
    );
  }

  const awsRuntimeCredentials = await resolveAwsRuntimeCredentials(
    fetchImpl,
    runtimeEnv,
  );
  if (awsRuntimeCredentials) {
    return awsRuntimeCredentials;
  }

  return staticCredentials;
};

/**
 * Recreate the S3 client with fresh credentials. The default
 * auto mode prefers AWS runtime roles for AWS S3 endpoints and
 * static env credentials for S3-compatible endpoints.
 *
 * Call at process startup and periodically in long-running
 * processes to prevent STS credential expiry.
 */
export const refreshS3 = async (): Promise<void> => {
  const credentials = await resolveS3Credentials();
  _client = buildS3Client(envBase.S3_BUCKET, credentials);
  _abortableClient = buildAbortableS3Client(credentials);
  _clientCreatedAt = Date.now();
};

const CREDENTIAL_MAX_AGE_MS = 50 * 60 * 1000;

// Lazily built so that importing this module's pure helpers
// (presignDownloadUrl, contentDisposition) does not construct an S3
// client at import time. refreshS3() — called at startup and
// periodically — replaces the client with credentials resolved via
// the configured provider.
let _client: S3Client | null = null;
let _abortableClient: AwsS3Client | null = null;
let _clientCreatedAt = 0;

/**
 * Returns the S3 client, building one from static env credentials on
 * first use. In normal operation refreshS3() runs at startup before
 * any request, so the lazy build here is only a fallback.
 */
export const getS3 = (): S3Client => {
  _client ??= buildS3Client(envBase.S3_BUCKET, staticCredentialsFromEnv());
  return _client;
};

const S3_WRITE_TIMEOUT_MS = 15_000;
const S3_WRITE_MAX_ATTEMPTS = 3;
const S3_WRITE_RETRY_BASE_DELAY_MS = 100;

/**
 * Write failures the service decided on: it received the request, applied a
 * rule, and rejected it. Replaying the same bytes reproduces the same
 * rejection, so a retry only makes the failure arrive later.
 */
const TERMINAL_S3_WRITE_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "EntityTooLarge",
  "InvalidAccessKeyId",
  "InvalidArgument",
  "InvalidRequest",
  "NoSuchBucket",
  "SignatureDoesNotMatch",
]);

/**
 * Everything outside `TERMINAL_S3_WRITE_CODES` retries, including codes we do
 * not recognise. The direction is deliberate: an allowlist of known-transient
 * codes lets the next unrecognised transport failure wedge its caller, which
 * is the bug this helper exists to prevent, while over-retrying costs only the
 * bounded backoff below.
 */
const isTerminalS3WriteError = (error: unknown): boolean =>
  error instanceof Error &&
  TERMINAL_S3_WRITE_CODES.has(safeErrorCode(error) ?? "");

/** Full jitter: spreads concurrent writers instead of resynchronising them. */
const s3WriteRetryDelayMs = (attempt: number): number =>
  Math.random() * S3_WRITE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);

type S3ObjectWrite = {
  contentType?: string | undefined;
  data: Uint8Array | string;
  /**
   * Must be deterministic for the bytes written — a content-addressed key, or
   * one derived from the record's stable identity. A timed-out attempt cannot
   * be cancelled (Bun's S3 client takes no abort signal), so it may still land
   * server-side after this helper has moved on to the next attempt. With a
   * deterministic key that duplicate is a no-op; with a generated key it would
   * leave an orphan object per attempt.
   */
  key: string;
};

type S3ObjectWriter = (write: S3ObjectWrite) => Promise<unknown>;

const writeViaClient: S3ObjectWriter = async ({ contentType, data, key }) =>
  await getS3().write(
    key,
    data,
    contentType === undefined ? undefined : { type: contentType },
  );

/**
 * Write one object with a per-attempt deadline and a bounded, jittered retry.
 *
 * A bare `getS3().write` has neither. Bun's S3 client holds long-lived
 * connections, so a peer that drops an idle socket surfaces the next write as
 * a transport failure (`ConnectionClosed`) rather than a rejection by the
 * service — transient, and cleared by retrying. Without a retry that failure
 * propagates to the caller, and a caller that holds an ingestion cursor on
 * failure cannot make progress past it.
 *
 * `write` is injected only by tests; production always uses the shared client.
 */
export const writeS3ObjectWithRetry = async (
  object: S3ObjectWrite,
  write: S3ObjectWriter = writeViaClient,
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= S3_WRITE_MAX_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by construction: each attempt must observe the previous one's failure
    const written = await Result.tryPromise({
      try: async () =>
        await withTimeout(async () => await write(object), {
          label: "s3 object write",
          timeoutMs: S3_WRITE_TIMEOUT_MS,
        }),
      catch: (cause) => cause,
    });
    if (!Result.isError(written)) {
      return;
    }
    lastError = written.error;
    if (isTerminalS3WriteError(written.error)) {
      break;
    }
    if (attempt < S3_WRITE_MAX_ATTEMPTS) {
      // oxlint-disable-next-line no-await-in-loop -- backoff between attempts is the point of the loop
      await Bun.sleep(s3WriteRetryDelayMs(attempt));
    }
  }
  // eslint-disable-next-line no-throw-literal -- preserve the SDK rejection object and its retry/status metadata for callers
  throw lastError;
};

class S3ObjectReadError extends TaggedError("S3ObjectReadError")<{
  message: string;
  status?: number;
  code?: string;
}> {}

export class S3ObjectBudgetError extends TaggedError("S3ObjectBudgetError")<{
  message: string;
  key: string;
  declaredBytes: number;
  maxBytes: number;
}> {}

export class MissingCorpusObjectError extends TaggedError(
  "MissingCorpusObjectError",
)<{
  message: string;
  key: string;
}> {}

export const isMissingCorpusObjectError = (
  error: unknown,
): error is MissingCorpusObjectError =>
  error instanceof MissingCorpusObjectError;

/**
 * Size of one object without reading it, so a caller can refuse an
 * oversized object before materializing it. Null when storage does not
 * report a length.
 */
export const getS3ObjectSizeWithSignal = async (
  key: string,
  signal: AbortSignal,
): Promise<number | null> => {
  _abortableClient ??= buildAbortableS3Client(staticCredentialsFromEnv());
  const response = await _abortableClient.send(
    new HeadObjectCommand({ Bucket: envBase.S3_BUCKET, Key: key }),
    { abortSignal: signal },
  );
  return response.ContentLength ?? null;
};

/** Read one object while allowing the caller to cancel the HTTP request. */
export const getS3ObjectWithSignal = async (
  key: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> => {
  _abortableClient ??= buildAbortableS3Client(staticCredentialsFromEnv());
  const response = await _abortableClient.send(
    new GetObjectCommand({ Bucket: envBase.S3_BUCKET, Key: key }),
    { abortSignal: signal },
  );
  if (!response.Body) {
    throw new S3ObjectReadError({
      message: "S3 returned an object without a response body",
    });
  }
  const bytes = await response.Body.transformToByteArray();
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

/**
 * Whether the store confirmed the object is not there, as opposed to
 * failing to answer.
 *
 * The distinction decides what a caller may record: an absent object is a
 * fact about the key, while a timeout, a refused credential or a dropped
 * connection says nothing about it. Treating the second as the first turns
 * a transient failure into a durable conclusion. The SDK reports absence as
 * a `NoSuchKey`/`NotFound` error name. A status-only 404 is not enough:
 * `NoSuchBucket` has the same status and says nothing about the key.
 */
export const isMissingS3ObjectError = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }
  const name = error["name"];
  if (name === "NoSuchKey" || name === "NotFound") {
    return true;
  }
  return false;
};

/**
 * Read one object, or `null` when the store confirms it holds no such key.
 * Every other failure is raised: see {@link isMissingS3ObjectError}.
 */
export const readS3ObjectIfPresent = async (
  key: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> => {
  const read = await Result.tryPromise({
    try: async () => await getS3ObjectWithSignal(key, signal),
    catch: (cause) => cause,
  });
  if (Result.isOk(read)) {
    return read.value;
  }
  if (isMissingS3ObjectError(read.error)) {
    return null;
  }
  throw read.error;
};

/** Delete one object while allowing the caller to cancel the HTTP request. */
export const deleteS3ObjectWithSignal = async (
  key: string,
  signal: AbortSignal,
): Promise<void> => {
  _abortableClient ??= buildAbortableS3Client(staticCredentialsFromEnv());
  await _abortableClient.send(
    new DeleteObjectCommand({ Bucket: envBase.S3_BUCKET, Key: key }),
    { abortSignal: signal },
  );
};

/** Publish one object while allowing the caller to cancel the HTTP request. */
export const putS3ObjectWithSignal = async (
  key: string,
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
): Promise<void> => {
  _abortableClient ??= buildAbortableS3Client(staticCredentialsFromEnv());
  await _abortableClient.send(
    new PutObjectCommand({
      Body: bytes,
      Bucket: envBase.S3_BUCKET,
      ContentType: mimeType,
      Key: key,
    }),
    { abortSignal: signal },
  );
};

type ListS3ObjectKeysOptions = {
  bucket: string;
  prefix: string;
  /** Ceiling on the keys returned; one more than it signals overflow. */
  maxKeys: number;
  signal: AbortSignal;
};

/**
 * Keys under `prefix`, at most `maxKeys + 1` of them so a caller can tell a
 * full page from an overflow without listing the whole prefix. Pages through
 * continuation tokens only as far as that ceiling requires.
 */
export const listS3ObjectKeys = async ({
  bucket,
  prefix,
  maxKeys,
  signal,
}: ListS3ObjectKeysOptions): Promise<string[]> => {
  const client = (_abortableClient ??= buildAbortableS3Client(
    staticCredentialsFromEnv(),
  ));
  const keys: string[] = [];
  // Each page names the next one, so the walk recurses instead of looping;
  // depth is bounded by the ceiling.
  const collectFrom = async (
    continuationToken: string | undefined,
  ): Promise<string[]> => {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: maxKeys + 1 - keys.length,
        ContinuationToken: continuationToken,
      }),
      { abortSignal: signal },
    );
    // The SDK omits `Contents` on an empty page.
    if (page.Contents) {
      for (const object of page.Contents) {
        if (object.Key !== undefined) {
          keys.push(object.Key);
        }
      }
    }
    const next = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (next === undefined || keys.length > maxKeys) {
      return keys;
    }
    return await collectFrom(next);
  };
  return await collectFrom(undefined);
};

type BoundedS3ReadOptions = {
  bucket: string;
  key: string;
  maxBytes: number;
  signal: AbortSignal;
};

/**
 * Read one object of at most `maxBytes`, refusing before the body is read
 * when the store declares a larger (or no) length. See
 * {@link readCorpusS3BytesBounded} for why the declared length is the bound.
 */
export const readS3ObjectBounded = async ({
  bucket,
  key,
  maxBytes,
  signal,
}: BoundedS3ReadOptions): Promise<Uint8Array> => {
  _abortableClient ??= buildAbortableS3Client(staticCredentialsFromEnv());
  const response = await _abortableClient.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: signal },
  );
  const declared = response.ContentLength;
  if (declared === undefined) {
    throw new S3ObjectReadError({
      message: `Object read for ${key} declared no usable length; refusing an unbounded read`,
    });
  }
  if (declared > maxBytes) {
    throw new S3ObjectBudgetError({
      message: `Object read for ${key} declares ${declared} bytes, past the ${maxBytes}-byte ceiling`,
      key,
      declaredBytes: declared,
      maxBytes,
    });
  }
  if (!response.Body) {
    throw new S3ObjectReadError({
      message: "S3 returned an object without a response body",
    });
  }
  return await response.Body.transformToByteArray();
};

/** True when credentials are older than 50 minutes (or not yet built). */
export const isS3Stale = (): boolean =>
  !_client || Date.now() - _clientCreatedAt > CREDENTIAL_MAX_AGE_MS;

// Separate client for the legal-corpus bucket. Shares the credential
// resolver but targets a different bucket, with its own staleness clock
// so the long-running ingestion daemon refreshes both before STS expiry.
let _corpusClient: S3Client | null = null;
let _abortableCorpusClient: AwsS3Client | null = null;
let _corpusClientCreatedAt = 0;

export const refreshCorpusS3 = async (): Promise<void> => {
  const credentials = await resolveS3Credentials();
  _corpusClient = buildS3Client(corpusBucket(), credentials);
  _abortableCorpusClient = buildAbortableS3Client(credentials);
  _corpusClientCreatedAt = Date.now();
};

export const getCorpusS3 = (): S3Client => {
  _corpusClient ??= buildS3Client(corpusBucket(), staticCredentialsFromEnv());
  return _corpusClient;
};

// The signed URL is consumed by the very next statement, so it only has to
// outlive one read.
const OBJECT_READ_PRESIGN_TTL_SECONDS = 300;
export const OBJECT_READ_TIMEOUT_MS = 5 * 60 * 1000;
const S3_ERROR_BODY_PREFIX_MAX_BYTES = 8 * 1024;
const S3_ERROR_CODE_OPEN_TAG = "<Code>";
const S3_ERROR_CODE_CLOSE_TAG = "</Code>";
const MISSING_CORPUS_OBJECT_CODES: ReadonlySet<string> = new Set([
  "NoSuchKey",
  "NotFound",
]);

const extractS3ErrorCode = (body: string): string | null => {
  const openingTag = body.indexOf(S3_ERROR_CODE_OPEN_TAG);
  if (openingTag === -1) {
    return null;
  }
  const codeStart = openingTag + S3_ERROR_CODE_OPEN_TAG.length;
  const closingTag = body.indexOf(S3_ERROR_CODE_CLOSE_TAG, codeStart);
  if (closingTag === -1) {
    return null;
  }
  const code = body.slice(codeStart, closingTag).trim();
  return code.length === 0 ? null : code;
};

const readS3ErrorBodyPrefix = async (response: Response): Promise<string> => {
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    const readNextChunk = async (): Promise<void> => {
      if (byteCount >= S3_ERROR_BODY_PREFIX_MAX_BYTES) {
        return;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        return panic("S3 error response stream returned a non-byte chunk");
      }
      const remaining = S3_ERROR_BODY_PREFIX_MAX_BYTES - byteCount;
      const value = chunk.value.subarray(0, remaining);
      chunks.push(value);
      byteCount += value.byteLength;
      if (value.byteLength < chunk.value.byteLength) {
        return;
      }
      await readNextChunk();
    };
    await readNextChunk();
    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
};

const readS3ResponseErrorCode = async (
  response: Response,
): Promise<string | null> => {
  const headerCode = response.headers.get("x-amz-error-code");
  if (headerCode !== null) {
    return headerCode.trim();
  }
  const body = await Result.tryPromise(
    async () => await readS3ErrorBodyPrefix(response),
  );
  if (body.isErr()) {
    return null;
  }
  return extractS3ErrorCode(body.value);
};

const throwCorpusObjectResponseError = async ({
  response,
  key,
  message,
}: {
  response: Response;
  key: string;
  message: string;
}): Promise<never> => {
  const code =
    response.status === 404 ? await readS3ResponseErrorCode(response) : null;
  if (code !== null && MISSING_CORPUS_OBJECT_CODES.has(code)) {
    throw new MissingCorpusObjectError({
      message: `Corpus object is absent: ${key}`,
      key,
    });
  }
  throw new S3ObjectReadError({
    message,
    status: response.status,
    ...(code === null ? {} : { code }),
  });
};

/**
 * Fetch an object body over a presigned URL when the caller needs response
 * metadata or real cancellation. Bun 1.4's native S3 body reads do not accept
 * an AbortSignal, so bounded and signal-bearing reads retain this path.
 *
 * The signed URL carries the caller's credentials in its query string. Pass
 * it straight to `fetch`; never log or store it.
 */
const fetchObject = async (
  client: S3Client,
  key: string,
  signal?: AbortSignal,
): Promise<Response> => {
  const response = await fetchWithTimeout(
    client.presign(key, { expiresIn: OBJECT_READ_PRESIGN_TTL_SECONDS }),
    { signal, timeoutMs: OBJECT_READ_TIMEOUT_MS },
  );
  if (!response.ok) {
    return await throwCorpusObjectResponseError({
      response,
      key,
      message: `Object read for ${key} failed with ${response.status}`,
    });
  }
  return response;
};

/** Read a legal-corpus object's bytes. See `fetchObject`. */
export const readCorpusS3Bytes = async (
  key: string,
  signal: AbortSignal,
): Promise<Uint8Array> =>
  await (await fetchObject(getCorpusS3(), key, signal)).bytes();

type BoundedCorpusReadOptions = {
  key: string;
  /** Ceiling on the transferred (still-compressed) body. */
  maxBytes: number;
  signal: AbortSignal;
};

/**
 * Read a legal-corpus object, refusing a body past `maxBytes`.
 *
 * `readCorpusS3Bytes` buffers whatever the store returns, so a decompression
 * ceiling applied afterwards bounds the decoded size but not the transfer: an
 * object overwritten with a very large body is already resident by the time
 * anything inspects it. This variant rejects before reading the body at all.
 *
 * The bound is the declared `Content-Length`. Every S3-compatible store sends
 * it for a GET of a stored object, because the length is known before the
 * response starts; a response that omits it is refused rather than read, so
 * the ceiling cannot be bypassed by withholding the header.
 */
export const readCorpusS3BytesBounded = async ({
  key,
  maxBytes,
  signal,
}: BoundedCorpusReadOptions): Promise<Uint8Array> => {
  const response = await fetchObject(getCorpusS3(), key, signal);
  // Tested as a header, not as a number. `Number(null)` is 0 and `Number("")`
  // is 0, so converting first would turn a missing or empty `Content-Length`
  // into a length of zero that passes every ceiling — making the refusal below
  // unreachable in exactly the case it exists for.
  const header = response.headers.get("content-length");
  const declared =
    header !== null && /^\d+$/u.test(header.trim()) ? Number(header) : null;
  if (declared === null) {
    throw new S3ObjectReadError({
      message: `Object read for ${key} declared no usable length; refusing an unbounded read`,
    });
  }
  if (declared > maxBytes) {
    throw new S3ObjectBudgetError({
      message: `Object read for ${key} declares ${declared} bytes, past the ${maxBytes}-byte ceiling`,
      key,
      declaredBytes: declared,
      maxBytes,
    });
  }
  return await response.bytes();
};

type CorpusRangeReadOptions = {
  key: string;
  /** First byte of the range, inclusive. */
  offset: number;
  /** Byte count; must be positive, a range GET cannot express zero bytes. */
  length: number;
  signal: AbortSignal;
};

// `Content-Range: bytes <first>-<last>/<complete-length>`; the complete
// length may be `*` when the store does not know it (RFC 9110 §14.4).
const CONTENT_RANGE_PATTERN = /^bytes (?<first>\d+)-(?<last>\d+)\/(?:\d+|\*)$/u;

/**
 * Read `length` bytes of a legal-corpus object starting at `offset` with a
 * range GET, so a member of a pack transfers without the pack around it.
 *
 * The response is accepted only as a 206 whose `Content-Range` names exactly
 * the requested range and whose `Content-Length` equals `length`. A store
 * that ignores the header answers 200 with the whole object; taking that
 * body would silently hand the caller the wrong bytes (and an unbounded
 * transfer), so anything but the exact partial response is refused. The
 * transfer is bounded by `length`, which the caller checks against its
 * ceiling before asking.
 */
export const readCorpusS3Range = async ({
  key,
  offset,
  length,
  signal,
}: CorpusRangeReadOptions): Promise<Uint8Array> => {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return panic(
      `Corpus range read offset must be a non-negative integer, got ${offset}`,
    );
  }
  if (!Number.isSafeInteger(length) || length < 1) {
    return panic(
      `Corpus range read length must be a positive integer, got ${length}`,
    );
  }
  const last = offset + length - 1;
  const response = await fetchWithTimeout(
    getCorpusS3().presign(key, { expiresIn: OBJECT_READ_PRESIGN_TTL_SECONDS }),
    {
      headers: { Range: `bytes=${offset}-${last}` },
      signal,
      timeoutMs: OBJECT_READ_TIMEOUT_MS,
    },
  );
  if (response.status !== 206) {
    return await throwCorpusObjectResponseError({
      response,
      key,
      message: `Range read for ${key} answered ${response.status}, not 206`,
    });
  }
  const contentRange = CONTENT_RANGE_PATTERN.exec(
    response.headers.get("content-range") ?? "",
  );
  const first = contentRange?.groups?.["first"];
  const servedLast = contentRange?.groups?.["last"];
  if (
    first === undefined ||
    servedLast === undefined ||
    Number(first) !== offset ||
    Number(servedLast) !== last
  ) {
    throw new S3ObjectReadError({
      message: `Range read for ${key} served a different range than bytes=${offset}-${last}`,
    });
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength === null || Number(contentLength.trim()) !== length) {
    throw new S3ObjectReadError({
      message: `Range read for ${key} declared ${contentLength ?? "no"} bytes, expected ${length}`,
    });
  }
  const bytes = await response.bytes();
  if (bytes.byteLength !== length) {
    throw new S3ObjectReadError({
      message: `Range read for ${key} returned ${bytes.byteLength} bytes, expected ${length}`,
    });
  }
  return bytes;
};

/**
 * Read a documents-bucket object with a hard deadline.
 *
 * Bun 1.4 fixes the native reader's retained-buffer bug, but its body reads do
 * not yet accept an AbortSignal. Keep production reads on the cancellable
 * transport until the native API can preserve this boundary's deadline.
 */
export const readS3ArrayBuffer = async (
  key: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> =>
  await (await fetchObject(getS3(), key, signal)).arrayBuffer();

/** Publish into the legal-corpus bucket with an abortable AWS SDK request. */
export const putCorpusS3ObjectWithSignal = async (
  key: string,
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
): Promise<void> => {
  _abortableCorpusClient ??= buildAbortableS3Client(staticCredentialsFromEnv());
  await _abortableCorpusClient.send(
    new PutObjectCommand({
      Body: bytes,
      Bucket: corpusBucket(),
      ContentType: mimeType,
      Key: key,
    }),
    { abortSignal: signal },
  );
};

/** Delete from the legal-corpus bucket with an abortable AWS SDK request. */
export const deleteCorpusS3ObjectWithSignal = async (
  key: string,
  signal: AbortSignal,
): Promise<void> => {
  _abortableCorpusClient ??= buildAbortableS3Client(staticCredentialsFromEnv());
  await _abortableCorpusClient.send(
    new DeleteObjectCommand({ Bucket: corpusBucket(), Key: key }),
    { abortSignal: signal },
  );
};

export const isCorpusS3Stale = (): boolean =>
  !_corpusClient || Date.now() - _corpusClientCreatedAt > CREDENTIAL_MAX_AGE_MS;

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
