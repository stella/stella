import { afterEach, describe, expect, test } from "bun:test";

import { lookupByMbs } from "./client.js";
import { SudregAPIError, SudregValidationError } from "./errors.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";
const FIXTURE = new URL("__fixtures__/company.html", import.meta.url);

const requestUrl = (input: URL | Request | string): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const installFetchStub = (
  handler: (
    input: URL | Request | string,
    init?: RequestInit,
  ) => Promise<Response>,
) => {
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

describe.skipIf(SKIP_LIVE)("SUDREG live", () => {
  test("looks up a filed Croatian company", async () => {
    const company = await lookupByMbs("080000014");
    expect(company?.mbs).toBe("080000014");
    expect(company?.name.length).toBeGreaterThan(0);
  });

  test("accepts the alternate official name heading", async () => {
    const company = await lookupByMbs("050023577");
    expect(company?.mbs).toBe("050023577");
    expect(company?.name).toBe("Dom za starije i nemoćne osobe Slavonski Brod");
  });
});

describe("SUDREG client", () => {
  let restore = () => {};
  afterEach(() => {
    restore();
    restore = () => {};
  });

  test("fetches and parses a company page", async () => {
    const fixture = await Bun.file(FIXTURE).text();
    let url = "";
    let signal: AbortSignal | null | undefined;
    restore = installFetchStub(async (input, init) => {
      url = requestUrl(input);
      signal = init?.signal;
      return new Response(fixture, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    const controller = new AbortController();
    const lookup = lookupByMbs("080 000 014", {
      signal: controller.signal,
    });
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
    const company = await lookup;
    expect(company?.name).toContain("PRIMJER");
    expect(url).toContain("p28_sbt_mbs=080000014");
  });

  test("returns null on an HTTP 404", async () => {
    restore = installFetchStub(async () => new Response("", { status: 404 }));
    expect(lookupByMbs("080000014")).resolves.toBeNull();
  });

  test("rejects malformed MBS values before fetch", () => {
    expect(lookupByMbs("80000014")).rejects.toBeInstanceOf(
      SudregValidationError,
    );
    expect(lookupByMbs("08000001A")).rejects.toBeInstanceOf(
      SudregValidationError,
    );
  });

  test("wraps upstream failures", async () => {
    restore = installFetchStub(
      async () => new Response("maintenance", { status: 503 }),
    );
    expect(lookupByMbs("080000014")).rejects.toBeInstanceOf(SudregAPIError);
  });
});
