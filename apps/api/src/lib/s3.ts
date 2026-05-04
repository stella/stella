import { S3Client } from "bun";

import { envBase } from "@/api/env-base";
import { contentDisposition } from "@/api/lib/content-disposition";

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

const fetchEcsCredentials = async ({
  fetchImpl = fetch,
  runtimeEnv = process.env,
}: {
  fetchImpl?: Fetcher;
  runtimeEnv?: CredentialRuntimeEnv;
} = {}): Promise<S3Credentials | null> => {
  const relativeUri = runtimeEnv["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  const fullUri = runtimeEnv["AWS_CONTAINER_CREDENTIALS_FULL_URI"];

  if (!relativeUri && !fullUri) {
    return null;
  }

  const url = (() => {
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
  })();

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
    const token = await Bun.file(authorizationTokenFile)
      .text()
      .catch(() => null);
    if (token) {
      headers["Authorization"] = token.trim();
    }
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

type OptionalS3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const buildS3Client = (creds?: OptionalS3Credentials | null): S3Client =>
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

type ResolveS3CredentialsOptions = {
  endpoint?: string;
  fetchImpl?: Fetcher;
  provider?: S3CredentialsProvider;
  runtimeEnv?: CredentialRuntimeEnv;
  staticCredentials?: OptionalS3Credentials | null;
};

const staticCredentialsFromEnv = (): OptionalS3Credentials | null => {
  if (!envBase.S3_ACCESS_KEY_ID || !envBase.S3_SECRET_ACCESS_KEY) {
    return null;
  }

  return {
    accessKeyId: envBase.S3_ACCESS_KEY_ID,
    secretAccessKey: envBase.S3_SECRET_ACCESS_KEY,
  };
};

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
  _client = buildS3Client(await resolveS3Credentials());
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
