import { afterEach, describe, expect, test } from "bun:test";

import {
  getS3,
  isMissingCorpusObjectError,
  isMissingS3ObjectError,
  isS3Stale,
  readCorpusS3BytesBounded,
  readCorpusS3Range,
  S3ObjectBudgetError,
  readS3ArrayBuffer,
  resolveS3Credentials,
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import { credentialsFromEnvValues } from "@/api/lib/s3-credentials";

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

describe("readCorpusS3BytesBounded", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reports a declared transfer overrun as a terminal budget error", async () => {
    const stub = async (): Promise<Response> =>
      await Promise.resolve(
        new Response(new Uint8Array(8), {
          headers: { "content-length": "8" },
        }),
      );
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });

    const rejection = await readCorpusS3BytesBounded({
      key: "legal-corpus/oversized.zst",
      maxBytes: 4,
      signal: new AbortController().signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(S3ObjectBudgetError);
    expect(rejection).toMatchObject({
      key: "legal-corpus/oversized.zst",
      declaredBytes: 8,
      maxBytes: 4,
    });
  });
});

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

  test("does not fall back to the instance role when the task token is unreadable", async () => {
    // IMDS answers with the EC2 instance's role, which on ECS is the host's
    // and is routinely broader than the task's. A task configured for
    // container credentials whose token file cannot be read must fail, not
    // quietly run under wider credentials than it was granted.
    const requestedUrls: string[] = [];
    const fetchImpl = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      requestedUrls.push(requestUrl(url));
      return ecsCredentialsResponse();
    };

    await resolveS3Credentials({
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      fetchImpl,
      runtimeEnv: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task",
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE:
          "/var/run/secrets/does-not-exist",
      },
    });

    // The property is which endpoint was asked, not what came back: the
    // credential endpoint is skipped (no usable Authorization header) and IMDS
    // is never reached, so no instance-role credential can enter the process.
    // Resolution falling through to configured static credentials afterwards
    // is a different source and not a widening.
    expect(requestedUrls).toEqual([]);
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

describe("credentialsFromEnvValues", () => {
  test("returns null when both env vars are unset", () => {
    expect(credentialsFromEnvValues(undefined, undefined)).toBeNull();
  });

  test("returns null when only access key is set", () => {
    expect(credentialsFromEnvValues("real-key", undefined)).toBeNull();
  });

  test("returns the configured credentials when both are real values", () => {
    expect(credentialsFromEnvValues("AKIA-real", "real-secret")).toEqual({
      accessKeyId: "AKIA-real",
      secretAccessKey: "real-secret",
    });
  });

  test("rejects the use-iam-role placeholder so we fall through to runtime resolution", () => {
    expect(credentialsFromEnvValues("use-iam-role", "use-iam-role")).toBeNull();
  });

  test("rejects when either side is the placeholder", () => {
    expect(credentialsFromEnvValues("AKIA-real", "use-iam-role")).toBeNull();
    expect(credentialsFromEnvValues("use-iam-role", "real-secret")).toBeNull();
  });

  test("treats an empty string as unset (defensive)", () => {
    expect(credentialsFromEnvValues("", "")).toBeNull();
  });

  test("rejects placeholder regardless of casing or surrounding whitespace", () => {
    expect(credentialsFromEnvValues("USE-IAM-ROLE", "use-iam-role")).toBeNull();
    expect(
      credentialsFromEnvValues("  use-iam-role  ", "  use-iam-role  "),
    ).toBeNull();
    expect(credentialsFromEnvValues("Use-Iam-Role", "use-iam-role")).toBeNull();
  });
});

describe("writeS3ObjectWithRetry", () => {
  const object = {
    contentType: "text/html",
    data: "<html></html>",
    key: "case-law/raw/source/hash",
  };

  const failingWriter =
    (
      attempts: { code?: string; count: number },
      failuresBeforeSuccess: number,
    ) =>
    async (): Promise<string> => {
      attempts.count += 1;
      if (attempts.count > failuresBeforeSuccess) {
        return await Promise.resolve("written");
      }
      throw Object.assign(new Error("an unexpected error has occurred"), {
        ...(attempts.code === undefined ? {} : { code: attempts.code }),
      });
    };

  test("a transient failure does not reach the caller", async () => {
    // The failure this helper exists for: one `ConnectionClosed` from a
    // dropped idle socket propagating out of a bare write. The case-law
    // pipeline holds its page cursor on any raw-upload failure, so a single
    // recoverable blip is enough to stall a whole source.
    const attempts = { code: "ConnectionClosed", count: 0 };

    const certainty = await writeS3ObjectWithRetry(
      object,
      failingWriter(attempts, 1),
    );

    expect(attempts.count).toBe(2);
    expect(certainty).toBe(S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN);
  });

  test("a first-attempt success is confirmed settled", async () => {
    const attempts = { count: 0 };

    const certainty = await writeS3ObjectWithRetry(
      object,
      failingWriter(attempts, 0),
    );

    expect(attempts.count).toBe(1);
    expect(certainty).toBe(S3_OBJECT_WRITE_CERTAINTY.CONFIRMED);
  });

  test("an unrecognised code retries rather than wedging the caller", async () => {
    // Retryability is a denylist, so a transport code nobody enumerated
    // still recovers. An allowlist would reintroduce the stall for every
    // code the list happens to miss.
    const attempts = { code: "SomeCodeNobodyEnumerated", count: 0 };

    const certainty = await writeS3ObjectWithRetry(
      object,
      failingWriter(attempts, 1),
    );

    expect(attempts.count).toBe(2);
    expect(certainty).toBe(S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN);
  });

  test("a terminal rejection is not retried", async () => {
    // AccessDenied is a decision, not a blip: replaying the same bytes
    // reproduces it, so retrying only delays the caller's failure.
    const attempts = { code: "AccessDenied", count: 0 };

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection = await writeS3ObjectWithRetry(
      object,
      failingWriter(attempts, Number.POSITIVE_INFINITY),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(attempts.count).toBe(1);
  });

  test("retries stay bounded and surface the last failure", async () => {
    // A permanently transient-looking failure must still terminate: the
    // caller needs to hear about it rather than have the write spin.
    const attempts = { code: "ConnectionClosed", count: 0 };
    const failures: Error[] = [];
    const write = async (): Promise<never> => {
      attempts.count += 1;
      const failure = Object.assign(
        new Error(`write attempt ${attempts.count} failed`),
        { code: attempts.code },
      );
      failures.push(failure);
      throw failure;
    };

    const rejection = await writeS3ObjectWithRetry(object, write).then(
      () => null,
      (error: unknown) => error,
    );

    expect(attempts.count).toBe(3);
    expect(rejection).toBe(failures.at(2));
  });
});

describe("isMissingS3ObjectError", () => {
  // The distinction this draws decides whether a caller may record "this
  // object is not there" against a key. Only the store's own answer counts;
  // a failure to reach the store is not an answer.
  const missing = [
    Object.assign(new Error("The specified key does not exist."), {
      name: "NoSuchKey",
    }),
    Object.assign(new Error("Not Found"), { name: "NotFound" }),
  ];

  const unanswered = [
    new Error("socket hang up"),
    Object.assign(new Error("Request aborted"), { name: "TimeoutError" }),
    Object.assign(new Error("The security token is invalid."), {
      name: "InvalidToken",
      $metadata: { httpStatusCode: 403 },
    }),
    Object.assign(new Error("Service unavailable"), {
      $metadata: { httpStatusCode: 503 },
    }),
    Object.assign(new Error("status without an S3 error code"), {
      $metadata: { httpStatusCode: 404 },
    }),
    Object.assign(new Error("The specified bucket does not exist."), {
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    }),
    new DOMException("aborted", "AbortError"),
    null,
    undefined,
    "NoSuchKey",
  ];

  test("a confirmed absence is recognised", () => {
    expect(missing.map(isMissingS3ObjectError)).toEqual(
      missing.map(() => true),
    );
  });

  test("a failure to reach the store is not an absence", () => {
    expect(unanswered.map(isMissingS3ObjectError)).toEqual(
      unanswered.map(() => false),
    );
  });
});

/**
 * The range reader is the only path that hands a caller a slice of a larger
 * object, so it is exercised against a fake store that serves exactly what
 * the request header names. A one-byte error in the header end would surface
 * as a body of the wrong length here.
 */
describe("readCorpusS3Range", () => {
  const originalFetch = globalThis.fetch;
  const object = new Uint8Array(256).map((_, index) => index);
  const seenRangeHeaders: string[] = [];

  // Serves the byte range the header names, the way an object store does.
  const rangeServingFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const range = headers.get("range");
    if (range === null) {
      return await Promise.resolve(new Response(object, { status: 200 }));
    }
    seenRangeHeaders.push(range);
    const match = /^bytes=(?<first>\d+)-(?<last>\d+)$/u.exec(range);
    const first = Number(match?.groups?.["first"]);
    const last = Number(match?.groups?.["last"]);
    const body = object.slice(first, last + 1);
    return await Promise.resolve(
      new Response(body, {
        status: 206,
        headers: {
          "content-range": `bytes ${first}-${last}/${object.byteLength}`,
          "content-length": String(body.byteLength),
        },
      }),
    );
  };

  const installFetch = (
    stub: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
  ) => {
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    seenRangeHeaders.length = 0;
  });

  test("asks for the inclusive range and returns exactly those bytes", async () => {
    installFetch(rangeServingFetch);

    const bytes = await readCorpusS3Range({
      key: "legal-corpus/packs/jurisdiction=SVK/p.pack",
      offset: 100,
      length: 7,
      signal: new AbortController().signal,
    });

    expect(seenRangeHeaders).toEqual(["bytes=100-106"]);
    expect([...bytes]).toEqual([100, 101, 102, 103, 104, 105, 106]);
  });

  test("refuses a store that ignores the range and answers 200", async () => {
    installFetch(async (input, init) => {
      const full = await rangeServingFetch(input, {
        ...init,
        headers: undefined,
      });
      return full;
    });

    const rejection: unknown = await readCorpusS3Range({
      key: "legal-corpus/packs/jurisdiction=SVK/p.pack",
      offset: 0,
      length: 8,
      signal: new AbortController().signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: expect.stringContaining("not 206"),
    });
  });

  test("distinguishes an absent corpus object from other 404 responses", async () => {
    const readRejection = async (body: string | null) => {
      installFetch(
        async () =>
          await Promise.resolve(
            new Response(body, {
              status: 404,
              ...(body === null
                ? {}
                : { headers: { "content-type": "application/xml" } }),
            }),
          ),
      );
      return await readCorpusS3Range({
        key: "legal-corpus/packs/jurisdiction=SVK/missing.pack",
        offset: 0,
        length: 8,
        signal: new AbortController().signal,
      }).then(
        () => null,
        (error: unknown) => error,
      );
    };

    expect(
      isMissingCorpusObjectError(
        await readRejection(
          "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingCorpusObjectError(
        await readRejection(
          "<Error><Code>NoSuchBucket</Code><Message>missing</Message></Error>",
        ),
      ),
    ).toBe(false);
    expect(isMissingCorpusObjectError(await readRejection(null))).toBe(false);
  });

  test("refuses a 206 whose Content-Range is not the requested range", async () => {
    installFetch(
      async () =>
        await Promise.resolve(
          new Response(object.slice(0, 8), {
            status: 206,
            headers: {
              "content-range": `bytes 1-8/${object.byteLength}`,
              "content-length": "8",
            },
          }),
        ),
    );

    const rejection: unknown = await readCorpusS3Range({
      key: "legal-corpus/packs/jurisdiction=SVK/p.pack",
      offset: 0,
      length: 8,
      signal: new AbortController().signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: expect.stringContaining("different range"),
    });
  });

  test("refuses a body whose length differs from the range", async () => {
    installFetch(
      async () =>
        await Promise.resolve(
          new Response(object.slice(0, 9), {
            status: 206,
            headers: {
              "content-range": `bytes 0-7/${object.byteLength}`,
              "content-length": "9",
            },
          }),
        ),
    );

    const rejection: unknown = await readCorpusS3Range({
      key: "legal-corpus/packs/jurisdiction=SVK/p.pack",
      offset: 0,
      length: 8,
      signal: new AbortController().signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: expect.stringContaining("expected 8"),
    });
  });
});

describe("readS3ArrayBuffer", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("installs a deadline when the caller supplies no signal", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const stub = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requestSignal = init?.signal;
      return await Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });

    const bytes = new Uint8Array(await readS3ArrayBuffer("documents/test"));

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
