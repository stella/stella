import { afterEach, describe, expect, test } from "bun:test";

import { isRecord } from "./guards.js";
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
  isRecord(value) && value["ok"] === true;

const installFetchStub = (
  handler: (
    input: URL | Request | string,
    init?: RequestInit,
  ) => Promise<Response>,
): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string, init?: RequestInit) =>
      handler(input, init),
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

const rejectWithSignalReason = (
  signal: AbortSignal,
  reject: (reason: Error) => void,
): void => {
  const reason: unknown = signal.reason;
  reject(
    reason instanceof Error
      ? reason
      : new Error("The request was aborted", { cause: reason }),
  );
};

const captureThrown = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

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
    restore = installFetchStub(async () => {
      throw new Error("The operation timed out");
    });
    const error = await captureThrown(
      performRegistryRequest({
        url: "https://example.test",
        wrapRequestError: (cause) =>
          new RequestMarkerError("wrapped", { cause }),
      }),
    );
    expect(error).toBeInstanceOf(RequestMarkerError);
  });

  test("returns the raw response on success", async () => {
    restore = installFetchStub(async () => jsonResponse({ ok: true }));
    const response = await performRegistryRequest({
      url: "https://example.test",
      wrapRequestError: (cause) => new RequestMarkerError("wrapped", { cause }),
    });
    expect(response.status).toBe(200);
  });

  test("composes caller cancellation with the mandatory timeout", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    let requestSignal: AbortSignal | null | undefined;
    restore = installFetchStub(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Missing request signal");
      }
      requestSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => rejectWithSignalReason(signal, reject),
          { once: true },
        );
      });
      return jsonResponse({ ok: true });
    });

    const request = performRegistryRequest({
      url: "https://example.test",
      signal: controller.signal,
      wrapRequestError: (cause) => new RequestMarkerError("wrapped", { cause }),
    });

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
    controller.abort(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(await captureThrown(request)).toBe(reason);
  });

  test("removes caller listeners after the request settles", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    restore = installFetchStub(async (_input, init) => {
      requestSignal = init?.signal;
      return jsonResponse({ ok: true });
    });

    await performRegistryRequest({
      url: "https://example.test",
      signal: controller.signal,
      wrapRequestError: (cause) => new RequestMarkerError("wrapped", { cause }),
    });

    controller.abort();
    expect(requestSignal?.aborted).toBe(false);
  });

  test("retains the timeout and maps it as a transport failure", async () => {
    restore = installFetchStub(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Missing request signal");
      }
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => rejectWithSignalReason(signal, reject),
          { once: true },
        );
      });
      return jsonResponse({ ok: true });
    });

    const error = await captureThrown(
      performRegistryRequest({
        url: "https://example.test",
        timeoutMs: 1,
        wrapRequestError: (cause) =>
          new RequestMarkerError("wrapped", { cause }),
      }),
    );
    expect(error).toMatchObject({
      name: "RequestMarkerError",
      cause: { name: "TimeoutError" },
    });
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
    const error = await captureThrown(
      readRegistryJson({
        response: new Response("<html>not json</html>", { status: 200 }),
        isExpectedShape: isShape,
        wrapParseError: (cause) => new ParseMarkerError("parse", { cause }),
        wrapShapeError: () => new ShapeMarkerError("shape"),
      }),
    );
    expect(error).toBeInstanceOf(ParseMarkerError);
  });

  test("maps an unexpected shape to the shape error", async () => {
    const error = await captureThrown(
      readRegistryJson({
        response: jsonResponse({ nope: 1 }),
        isExpectedShape: isShape,
        wrapParseError: (cause) => new ParseMarkerError("parse", { cause }),
        wrapShapeError: () => new ShapeMarkerError("shape"),
      }),
    );
    expect(error).toBeInstanceOf(ShapeMarkerError);
  });
});

describe("registryFetch", () => {
  test("parses and guards a successful JSON body", async () => {
    restore = installFetchStub(async () => jsonResponse({ ok: true }));
    const result = await registryFetch(baseOptions);
    expect(result).toEqual({ ok: true });
  });

  test("wraps a transport failure via wrapRequestError", async () => {
    restore = installFetchStub(async () => {
      throw new Error("timed out");
    });
    const error = await captureThrown(registryFetch(baseOptions));
    expect(error).toBeInstanceOf(RequestMarkerError);
  });

  test("delegates a non-OK status to onErrorResponse (throws)", async () => {
    restore = installFetchStub(async () => jsonResponse({ error: true }, 500));
    const error = await captureThrown(registryFetch(baseOptions));
    expect(error).toBeInstanceOf(ApiMarkerError);
  });

  test("lets onErrorResponse resolve a not-found status to null", async () => {
    restore = installFetchStub(async () => jsonResponse({ error: true }, 404));
    expect(await registryFetch(baseOptions)).toBeNull();
  });

  test("maps a malformed 2xx JSON body to the parse error", async () => {
    restore = installFetchStub(async () => new Response("}{", { status: 200 }));
    const error = await captureThrown(registryFetch(baseOptions));
    expect(error).toBeInstanceOf(ParseMarkerError);
  });

  test("maps an unexpected 2xx shape to the shape error", async () => {
    restore = installFetchStub(async () => jsonResponse({ nope: true }));
    const error = await captureThrown(registryFetch(baseOptions));
    expect(error).toBeInstanceOf(ShapeMarkerError);
  });

  test("routes a 429 to onRateLimited when provided, before onErrorResponse", async () => {
    restore = installFetchStub(async () => jsonResponse({ error: true }, 429));
    class RateMarkerError extends Error {
      override name = "RateMarkerError";
    }
    const error = await captureThrown(
      registryFetch({
        ...baseOptions,
        onRateLimited: () => {
          throw new RateMarkerError("rate limited");
        },
      }),
    );
    expect(error).toBeInstanceOf(RateMarkerError);
  });

  test("falls back to onErrorResponse for a 429 when onRateLimited is absent", async () => {
    restore = installFetchStub(async () => jsonResponse({ error: true }, 429));
    const error = await captureThrown(registryFetch(baseOptions));
    expect(error).toBeInstanceOf(ApiMarkerError);
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
