import { afterEach, describe, expect, test } from "bun:test";

import {
  parseRetryAfterMs,
  performRegistryRequest,
  rateLimitedError,
  readRegistryJson,
  registryFetch,
} from "./http.js";

// Distinct marker errors so assertions can tell which mapping fired.
class RequestMarkerError extends Error {
  override name = "RequestMarkerError";
}
class ParseMarkerError extends Error {
  override name = "ParseMarkerError";
}
class ShapeMarkerError extends Error {
  override name = "ShapeMarkerError";
}
class ApiMarkerError extends Error {
  override name = "ApiMarkerError";
}

type Shape = { ok: true };
const isShape = (value: unknown): value is Shape =>
  typeof value === "object" && value !== null && (value as Shape).ok === true;

const installFetchStub = (
  handler: (input: URL | Request | string) => Promise<Response>,
): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string) => handler(input),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const baseOptions = {
  url: "https://example.test/lookup",
  isExpectedShape: isShape,
  wrapRequestError: (cause: unknown) =>
    new RequestMarkerError("request", { cause }),
  wrapParseError: (_response: Response, cause: unknown) =>
    new ParseMarkerError("parse", { cause }),
  wrapShapeError: (_response: Response) => new ShapeMarkerError("shape"),
  onErrorResponse: (response: Response) => {
    if (response.status === 404) {
      return null;
    }
    throw new ApiMarkerError(`api ${response.status}`);
  },
};

describe("performRegistryRequest", () => {
  test("wraps a transport/timeout failure via wrapRequestError", async () => {
    restore = installFetchStub(() =>
      Promise.reject(new Error("The operation timed out")),
    );
    await expect(
      performRegistryRequest({
        url: "https://example.test",
        wrapRequestError: (cause) =>
          new RequestMarkerError("wrapped", { cause }),
      }),
    ).rejects.toBeInstanceOf(RequestMarkerError);
  });

  test("returns the raw response on success", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    const response = await performRegistryRequest({
      url: "https://example.test",
      wrapRequestError: (cause) => new RequestMarkerError("wrapped", { cause }),
    });
    expect(response.status).toBe(200);
  });
});

describe("readRegistryJson", () => {
  test("returns the guarded body on a valid shape", async () => {
    const body = await readRegistryJson({
      response: jsonResponse({ ok: true }),
      isExpectedShape: isShape,
      wrapParseError: (cause) => new ParseMarkerError("parse", { cause }),
      wrapShapeError: () => new ShapeMarkerError("shape"),
    });
    expect(body).toEqual({ ok: true });
  });

  test("maps a non-JSON body to the parse error", async () => {
    await expect(
      readRegistryJson({
        response: new Response("<html>not json</html>", { status: 200 }),
        isExpectedShape: isShape,
        wrapParseError: (cause) => new ParseMarkerError("parse", { cause }),
        wrapShapeError: () => new ShapeMarkerError("shape"),
      }),
    ).rejects.toBeInstanceOf(ParseMarkerError);
  });

  test("maps an unexpected shape to the shape error", async () => {
    await expect(
      readRegistryJson({
        response: jsonResponse({ nope: 1 }),
        isExpectedShape: isShape,
        wrapParseError: (cause) => new ParseMarkerError("parse", { cause }),
        wrapShapeError: () => new ShapeMarkerError("shape"),
      }),
    ).rejects.toBeInstanceOf(ShapeMarkerError);
  });
});

describe("registryFetch", () => {
  test("parses and guards a successful JSON body", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    const result = await registryFetch(baseOptions);
    expect(result).toEqual({ ok: true });
  });

  test("wraps a transport failure via wrapRequestError", async () => {
    restore = installFetchStub(() => Promise.reject(new Error("timed out")));
    await expect(registryFetch(baseOptions)).rejects.toBeInstanceOf(
      RequestMarkerError,
    );
  });

  test("delegates a non-OK status to onErrorResponse (throws)", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(jsonResponse({ error: true }, 500)),
    );
    await expect(registryFetch(baseOptions)).rejects.toBeInstanceOf(
      ApiMarkerError,
    );
  });

  test("lets onErrorResponse resolve a not-found status to null", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(jsonResponse({ error: true }, 404)),
    );
    await expect(registryFetch(baseOptions)).resolves.toBeNull();
  });

  test("maps a malformed 2xx JSON body to the parse error", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(new Response("}{", { status: 200 })),
    );
    await expect(registryFetch(baseOptions)).rejects.toBeInstanceOf(
      ParseMarkerError,
    );
  });

  test("maps an unexpected 2xx shape to the shape error", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(jsonResponse({ nope: true })),
    );
    await expect(registryFetch(baseOptions)).rejects.toBeInstanceOf(
      ShapeMarkerError,
    );
  });

  test("routes a 429 to onRateLimited when provided, before onErrorResponse", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(jsonResponse({ error: true }, 429)),
    );
    class RateMarkerError extends Error {
      override name = "RateMarkerError";
    }
    await expect(
      registryFetch({
        ...baseOptions,
        onRateLimited: () => {
          throw new RateMarkerError("rate limited");
        },
      }),
    ).rejects.toBeInstanceOf(RateMarkerError);
  });

  test("falls back to onErrorResponse for a 429 when onRateLimited is absent", async () => {
    restore = installFetchStub(() =>
      Promise.resolve(jsonResponse({ error: true }, 429)),
    );
    await expect(registryFetch(baseOptions)).rejects.toBeInstanceOf(
      ApiMarkerError,
    );
  });
});

describe("parseRetryAfterMs", () => {
  test("reads the delta-seconds form", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "120" },
    });
    expect(parseRetryAfterMs(response)).toBe(120_000);
  });

  test("returns null when the header is absent", () => {
    expect(parseRetryAfterMs(new Response(null, { status: 429 }))).toBeNull();
  });

  test("returns null for an unparseable header", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "soon" },
    });
    expect(parseRetryAfterMs(response)).toBeNull();
  });
});

describe("rateLimitedError", () => {
  test("builds a RegistryRateLimitedError carrying the retry budget", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "5" },
    });
    const error = rateLimitedError({ response, message: "slow down" });
    expect(error.name).toBe("RegistryRateLimitedError");
    expect(error.retryAfterMs).toBe(5000);
    expect(error.message).toBe("slow down");
  });
});
