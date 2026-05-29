import { describe, expect, test } from "bun:test";

import {
  getS3,
  isS3Stale,
  resolveS3Credentials,
  staticCredentialsFromEnv,
} from "@/api/lib/s3";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

const ecsCredentialsResponse = (): Response =>
  jsonResponse({
    AccessKeyId: "ecs-access-key",
    SecretAccessKey: "ecs-secret-key",
    Token: "ecs-session-token",
  });

const notFoundResponse = (): Response => new Response(null, { status: 404 });

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
};

const createTrackedEcsCredentialsFetch =
  (requestedUrls: string[]) =>
  async (url: string | URL | Request): Promise<Response> => {
    requestedUrls.push(requestUrl(url));

    return ecsCredentialsResponse();
  };

describe("resolveS3Credentials", () => {
  test("treats a lazily built fallback client as stale", () => {
    getS3();

    expect(isS3Stale()).toBe(true);
  });

  test("prefers ECS task credentials over static credentials for AWS S3 endpoints", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = createTrackedEcsCredentialsFetch(requestedUrls);

    const credentials = await resolveS3Credentials({
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      fetchImpl,
      runtimeEnv: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task",
      },
      staticCredentials: {
        accessKeyId: "static-access-key",
        secretAccessKey: "static-secret-key",
      },
    });

    expect(credentials).toEqual({
      accessKeyId: "ecs-access-key",
      secretAccessKey: "ecs-secret-key",
      sessionToken: "ecs-session-token",
    });
    expect(requestedUrls).toEqual(["http://169.254.170.2/v2/credentials/task"]);
  });

  test("prefers static credentials for S3-compatible endpoints in auto mode", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = createTrackedEcsCredentialsFetch(requestedUrls);

    const credentials = await resolveS3Credentials({
      endpoint: "https://s3.example.com",
      fetchImpl,
      runtimeEnv: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task",
      },
      staticCredentials: {
        accessKeyId: "static-access-key",
        secretAccessKey: "static-secret-key",
      },
    });

    expect(credentials).toEqual({
      accessKeyId: "static-access-key",
      secretAccessKey: "static-secret-key",
    });
    expect(requestedUrls).toEqual([]);
  });

  test("supports explicit AWS runtime credentials for S3-compatible endpoints", async () => {
    const fetchImpl = async (): Promise<Response> => ecsCredentialsResponse();

    const credentials = await resolveS3Credentials({
      endpoint: "https://s3.example.com",
      fetchImpl,
      provider: "aws-runtime",
      runtimeEnv: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task",
      },
      staticCredentials: {
        accessKeyId: "static-access-key",
        secretAccessKey: "static-secret-key",
      },
    });

    expect(credentials).toEqual({
      accessKeyId: "ecs-access-key",
      secretAccessKey: "ecs-secret-key",
      sessionToken: "ecs-session-token",
    });
  });

  test("falls back to static credentials when AWS metadata credentials are unavailable", async () => {
    const fetchImpl = async (): Promise<Response> => notFoundResponse();

    const credentials = await resolveS3Credentials({
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      fetchImpl,
      runtimeEnv: {},
      staticCredentials: {
        accessKeyId: "static-access-key",
        secretAccessKey: "static-secret-key",
      },
    });

    expect(credentials).toEqual({
      accessKeyId: "static-access-key",
      secretAccessKey: "static-secret-key",
    });
  });

  test("ignores invalid ECS relative credential URIs", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      requestedUrls.push(requestUrl(url));

      return notFoundResponse();
    };

    const credentials = await resolveS3Credentials({
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      fetchImpl,
      runtimeEnv: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "v2/credentials/task",
      },
      staticCredentials: {
        accessKeyId: "static-access-key",
        secretAccessKey: "static-secret-key",
      },
    });

    expect(credentials).toEqual({
      accessKeyId: "static-access-key",
      secretAccessKey: "static-secret-key",
    });
    expect(requestedUrls).toEqual(["http://169.254.169.254/latest/api/token"]);
  });
});

describe("staticCredentialsFromEnv", () => {
  test("returns null when both env vars are unset", () => {
    expect(
      staticCredentialsFromEnv({
        accessKeyId: undefined,
        secretAccessKey: undefined,
      }),
    ).toBeNull();
  });

  test("returns null when only access key is set", () => {
    expect(
      staticCredentialsFromEnv({
        accessKeyId: "real-key",
        secretAccessKey: undefined,
      }),
    ).toBeNull();
  });

  test("returns the configured credentials when both are real values", () => {
    expect(
      staticCredentialsFromEnv({
        accessKeyId: "AKIA-real",
        secretAccessKey: "real-secret",
      }),
    ).toEqual({
      accessKeyId: "AKIA-real",
      secretAccessKey: "real-secret",
    });
  });

  test("rejects the use-iam-role placeholder so we fall through to runtime resolution", () => {
    expect(
      staticCredentialsFromEnv({
        accessKeyId: "use-iam-role",
        secretAccessKey: "use-iam-role",
      }),
    ).toBeNull();
  });

  test("rejects when either side is the placeholder", () => {
    expect(
      staticCredentialsFromEnv({
        accessKeyId: "AKIA-real",
        secretAccessKey: "use-iam-role",
      }),
    ).toBeNull();
    expect(
      staticCredentialsFromEnv({
        accessKeyId: "use-iam-role",
        secretAccessKey: "real-secret",
      }),
    ).toBeNull();
  });

  test("treats an empty string as unset (defensive)", () => {
    expect(
      staticCredentialsFromEnv({
        accessKeyId: "",
        secretAccessKey: "",
      }),
    ).toBeNull();
  });
});
