import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import appleFixture from "./__fixtures__/cik-apple.json" with { type: "json" };
import { lookupByCik } from "./client.js";
import { EdgarAPIError, EdgarValidationError } from "./errors.js";

const MISSING_FIXTURE_PATH = path.join(
  import.meta.dirname,
  "__fixtures__",
  "cik-missing.xml",
);

const TEST_USER_AGENT = "Stella stella@example.com";

const LIVE_USER_AGENT = process.env["EDGAR_USER_AGENT"];
const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1" || !LIVE_USER_AGENT;

type FetchCapture = {
  url: string;
  userAgent: string;
};

type StubResult = {
  captured: FetchCapture;
  restore: () => void;
};

const captureRequest = (
  status: number,
  body: BodyInit | null,
  contentType = "application/json",
): StubResult => {
  const captured: FetchCapture = { url: "", userAgent: "" };
  const originalFetch = globalThis.fetch;
  const readUrl = (input: URL | RequestInfo): string => {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return input.url;
  };
  const stub = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = readUrl(input);
    const headers = new Headers(init?.headers);
    captured.userAgent = headers.get("User-Agent") ?? "";
    return new Response(body, {
      status,
      headers: { "Content-Type": contentType },
    });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
  const restore = (): void => {
    globalThis.fetch = originalFetch;
  };
  return { captured, restore };
};

const captureThrown = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("lookupByCik validation", () => {
  const config = { userAgent: TEST_USER_AGENT };

  test("rejects empty CIK", async () => {
    const error = await captureThrown(lookupByCik("", config));
    expect(error).toBeInstanceOf(EdgarValidationError);
  });

  test("rejects non-numeric CIK", async () => {
    const error = await captureThrown(lookupByCik("APPLE", config));
    expect(error).toBeInstanceOf(EdgarValidationError);
  });

  test("rejects more than 10 digits", async () => {
    const error = await captureThrown(lookupByCik("12345678901", config));
    expect(error).toBeInstanceOf(EdgarValidationError);
  });

  test("rejects empty User-Agent", async () => {
    const empty = await captureThrown(lookupByCik("320193", { userAgent: "" }));
    expect(empty).toBeInstanceOf(EdgarValidationError);
    const whitespace = await captureThrown(
      lookupByCik("320193", { userAgent: "   " }),
    );
    expect(whitespace).toBeInstanceOf(EdgarValidationError);
  });
});

describe("lookupByCik mocked", () => {
  let restore = (): void => {};
  afterEach(() => {
    restore();
  });

  test("returns the parsed Apple submission on hit", async () => {
    const ctx = captureRequest(200, JSON.stringify(appleFixture));
    restore = ctx.restore;

    const result = await lookupByCik("320193", { userAgent: TEST_USER_AGENT });
    expect(result).not.toBeNull();
    expect(result?.cik).toBe("0000320193");
    expect(result?.name).toBe("Apple Inc.");
    expect(result?.tickers).toEqual(["AAPL"]);
    expect(ctx.captured.url).toBe(
      "https://data.sec.gov/submissions/CIK0000320193.json",
    );
    expect(ctx.captured.userAgent).toBe(TEST_USER_AGENT);
  });

  test("returns null on 404", async () => {
    const missingBody = await Bun.file(MISSING_FIXTURE_PATH).text();
    const ctx = captureRequest(404, missingBody, "application/xml");
    restore = ctx.restore;

    const result = await lookupByCik("9999999999", {
      userAgent: TEST_USER_AGENT,
    });
    expect(result).toBeNull();
  });

  test("translates a 403 into a descriptive EdgarAPIError", async () => {
    const ctx = captureRequest(403, "Forbidden", "text/plain");
    restore = ctx.restore;

    const error = await captureThrown(
      lookupByCik("320193", { userAgent: TEST_USER_AGENT }),
    );
    expect(error).toBeInstanceOf(EdgarAPIError);
    expect(error).toMatchObject({ httpStatus: 403 });
  });

  test("wraps other non-OK responses as EdgarAPIError", async () => {
    const ctx = captureRequest(502, "Bad Gateway", "text/plain");
    restore = ctx.restore;

    const error = await captureThrown(
      lookupByCik("320193", { userAgent: TEST_USER_AGENT }),
    );
    expect(error).toBeInstanceOf(EdgarAPIError);
    expect(error).toMatchObject({ httpStatus: 502 });
  });
});

// Live smoke tests hit the real SEC API. They double as integration
// tests and document the expected response shape for known issuers.
describe.skipIf(SKIP_LIVE)("lookupByCik live", () => {
  test("returns Apple Inc. for CIK 320193", async () => {
    const result = await lookupByCik("320193", {
      userAgent: LIVE_USER_AGENT ?? TEST_USER_AGENT,
    });
    expect(result).not.toBeNull();
    expect(result?.cik).toBe("0000320193");
    expect(result?.name).toContain("Apple");
    expect(result?.tickers).toContain("AAPL");
  });

  test("returns null for an unregistered CIK", async () => {
    const result = await lookupByCik("9999999999", {
      userAgent: LIVE_USER_AGENT ?? TEST_USER_AGENT,
    });
    expect(result).toBeNull();
  });
});
