import { describe, expect, test } from "bun:test";

import { resolveS3Credentials } from "@/api/lib/s3";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

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

describe("resolveS3Credentials", () => {
  test("prefers ECS task credentials over static credentials for AWS S3 endpoints", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      requestedUrls.push(requestUrl(url));

      return jsonResponse({
        AccessKeyId: "ecs-access-key",
        SecretAccessKey: "ecs-secret-key",
        Token: "ecs-session-token",
      });
    };

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
    const fetchImpl = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      requestedUrls.push(requestUrl(url));

      return jsonResponse({
        AccessKeyId: "ecs-access-key",
        SecretAccessKey: "ecs-secret-key",
        Token: "ecs-session-token",
      });
    };

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
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({
        AccessKeyId: "ecs-access-key",
        SecretAccessKey: "ecs-secret-key",
        Token: "ecs-session-token",
      });

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
