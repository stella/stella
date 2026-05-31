import { afterEach, describe, expect, test } from "bun:test";

import { lookupByTaxId, searchByName } from "./client.js";
import { GcisAPIError, GcisValidationError } from "./errors.js";
import type { GcisResponse } from "./types.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const readFixture = async (name: string): Promise<GcisResponse> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are captured directly from the live GCIS API
  // and committed alongside the tests; runtime validation here would
  // only catch drift between an upstream payload and the committed
  // JSON, which is precisely what the assertions below check.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as GcisResponse;
};

const installFetchStub = (
  handler: (input: URL | Request | string) => Promise<Response>,
) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string) => handler(input),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

const fetchInputToString = (input: URL | Request | string): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

// ---------------------------------------------------------------------------
// Live tests — opt-in via SMOKE_TEST=1. Mirror the brreg / prh pattern.
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_LIVE)("lookupByTaxId live", () => {
  test("returns TSMC by tongbian", async () => {
    const result = await lookupByTaxId("22099131");
    expect(result).not.toBeNull();
    expect(result?.taxId).toBe("22099131");
    expect(result?.name).toContain("台灣積體電路");
    expect(result?.status).toEqual({ type: "active" });
    expect(result?.registryUrl).toContain("22099131");
  });
});

describe.skipIf(SKIP_LIVE)("searchByName live", () => {
  test("finds entities with 台積電 in the name", async () => {
    const results = await searchByName("台積電", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => /^\d{8}$/u.test(entry.taxId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mocked fetch tests using captured upstream fixtures.
// ---------------------------------------------------------------------------
describe("lookupByTaxId (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the live TSMC payload", async () => {
    const body = await readFixture("lookup-tsmc.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupByTaxId("22099131");
    expect(company).not.toBeNull();
    expect(company?.taxId).toBe("22099131");
    expect(company?.name).toBe("台灣積體電路製造股份有限公司");
    expect(company?.responsibleName).toBe("魏哲家");
    expect(company?.capitalAmount).toBe(280_500_000_000);
    expect(company?.paidInCapitalAmount).toBe(259_323_700_670);
    expect(company?.setupDate).toBe("1987-02-21");
    expect(company?.lastChangeDate).toBe("2026-05-25");
    expect(company?.status).toEqual({ type: "active" });
    expect(company?.statusDescription).toBe("核准設立");
  });

  test("returns null when GCIS responds with an empty array", async () => {
    const body = await readFixture("lookup-not-found.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupByTaxId("12345676");
    expect(company).toBeNull();
  });

  test("returns null on an empty-body 200 (GCIS's actual not-found shape)", async () => {
    // In production GCIS responds with `Content-Length: 0` rather
    // than an explicit `[]`; the JSON parser must not choke on that.
    restore = installFetchStub(
      async () =>
        new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupByTaxId("12345676");
    expect(company).toBeNull();
  });

  test("surfaces a 500 upstream as GcisAPIError", async () => {
    restore = installFetchStub(
      async () =>
        new Response("Internal error", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
    );

    expect(lookupByTaxId("22099131")).rejects.toMatchObject({
      name: "GcisAPIError",
      httpStatus: 500,
    });
  });

  test("treats an HTML 'system busy' page as GcisAPIError", async () => {
    // GCIS serves a Chinese HTML maintenance page with HTTP 200 when
    // its origin is under load; parsing that as JSON would throw a
    // bare SyntaxError. The adapter must convert it into a structured
    // error so the dispatch layer maps it to a 502.
    restore = installFetchStub(
      async () =>
        new Response("<html><body>系統忙碌中，請稍後再試一次</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );

    expect(lookupByTaxId("22099131")).rejects.toMatchObject({
      name: "GcisAPIError",
    });
  });
});

describe("searchByName (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the 台積電 search page", async () => {
    const body = await readFixture("search-taiji.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const results = await searchByName("台積電");
    expect(results.length).toBe(2);
    expect(results[0]?.taxId).toBe("54900838");
    expect(results[0]?.name).toBe("台積電機有限公司");
    expect(results[0]?.status).toEqual({ type: "active" });
  });

  test("forwards $top to upstream and includes the active-status filter", async () => {
    const captured: string[] = [];
    restore = installFetchStub(async (input) => {
      captured.push(fetchInputToString(input));
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await searchByName("台積", { limit: 7 });
    const url = captured.at(0);
    expect(url).toBeDefined();
    expect(url).toContain("%24top=7");
    expect(url).toContain("Company_Status+eq+01");
  });

  test("omits the status filter when activeOnly=false", async () => {
    const captured: string[] = [];
    restore = installFetchStub(async (input) => {
      captured.push(fetchInputToString(input));
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await searchByName("台積", { activeOnly: false });
    const url = captured.at(0);
    expect(url).toBeDefined();
    expect(url).not.toContain("Company_Status");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("lookupByTaxId validation", () => {
  test("rejects format violations", () => {
    expect(lookupByTaxId("1234567")).rejects.toBeInstanceOf(
      GcisValidationError,
    );
    expect(lookupByTaxId("abcdefgh")).rejects.toBeInstanceOf(
      GcisValidationError,
    );
  });

  test("rejects bad checksum", () => {
    // 22099131 is valid; bump the check digit.
    expect(lookupByTaxId("22099130")).rejects.toBeInstanceOf(
      GcisValidationError,
    );
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", () => {
    expect(searchByName("")).rejects.toBeInstanceOf(GcisValidationError);
    expect(searchByName("  ")).rejects.toBeInstanceOf(GcisValidationError);
  });
});

// Smoke: GcisAPIError export is reachable.
test("exports GcisAPIError", () => {
  expect(GcisAPIError).toBeDefined();
});
