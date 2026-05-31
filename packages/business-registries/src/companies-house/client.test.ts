import { afterEach, describe, expect, test } from "bun:test";

import missingFixture from "./__fixtures__/company-missing.json" with { type: "json" };
import tescoFixture from "./__fixtures__/company-tesco.json" with { type: "json" };
import officersFixture from "./__fixtures__/officers-tesco.json" with { type: "json" };
import searchFixture from "./__fixtures__/search-tesco.json" with { type: "json" };
import {
  lookupByCompanyNumber,
  lookupOfficersByCompanyNumber,
  searchByName,
} from "./client.js";
import {
  CompaniesHouseAPIError,
  CompaniesHouseAuthError,
  CompaniesHouseValidationError,
} from "./errors.js";

const TEST_API_KEY = "test-api-key-not-real";
const LIVE_API_KEY = process.env["COMPANIES_HOUSE_API_KEY"];
const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1" || !LIVE_API_KEY;

type FetchCapture = {
  url: string;
  authorization: string;
};

type StubResult = {
  captured: FetchCapture;
  restore: () => void;
};

const readRequestUrl = (input: URL | RequestInfo): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const captureRequest = (
  status: number,
  body: BodyInit | null,
  contentType = "application/json",
): StubResult => {
  const captured: FetchCapture = { url: "", authorization: "" };
  const originalFetch = globalThis.fetch;
  const stub = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = readRequestUrl(input);
    const headers = new Headers(init?.headers);
    captured.authorization = headers.get("Authorization") ?? "";
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

describe("lookupByCompanyNumber validation", () => {
  const config = { apiKey: TEST_API_KEY };

  test("rejects empty API key", async () => {
    const error = await captureThrown(
      lookupByCompanyNumber("00445790", { apiKey: "" }),
    );
    expect(error).toBeInstanceOf(CompaniesHouseAuthError);
    const whitespace = await captureThrown(
      lookupByCompanyNumber("00445790", { apiKey: "   " }),
    );
    expect(whitespace).toBeInstanceOf(CompaniesHouseAuthError);
  });

  test("rejects empty CRN", async () => {
    const error = await captureThrown(lookupByCompanyNumber("", config));
    expect(error).toBeInstanceOf(CompaniesHouseValidationError);
  });

  test("rejects non-alphanumeric CRN", async () => {
    const error = await captureThrown(
      lookupByCompanyNumber("not-a-crn", config),
    );
    expect(error).toBeInstanceOf(CompaniesHouseValidationError);
  });

  test("rejects 9+ character CRN", async () => {
    const error = await captureThrown(
      lookupByCompanyNumber("123456789", config),
    );
    expect(error).toBeInstanceOf(CompaniesHouseValidationError);
  });

  test("rejects the reserved all-zero CRN", async () => {
    const error = await captureThrown(
      lookupByCompanyNumber("00000000", config),
    );
    expect(error).toBeInstanceOf(CompaniesHouseValidationError);
  });
});

describe("lookupByCompanyNumber mocked", () => {
  let restore = (): void => {};
  afterEach(() => {
    restore();
  });

  test("returns the parsed Tesco profile on hit and zero-pads the URL", async () => {
    const ctx = captureRequest(200, JSON.stringify(tescoFixture));
    restore = ctx.restore;

    const result = await lookupByCompanyNumber("445790", {
      apiKey: TEST_API_KEY,
    });
    expect(result).not.toBeNull();
    expect(result?.companyNumber).toBe("00445790");
    expect(result?.name).toBe("TESCO PLC");
    expect(result?.status.type).toBe("active");
    expect(ctx.captured.url).toBe(
      "https://api.company-information.service.gov.uk/company/00445790",
    );
    // HTTP Basic with empty password: base64("test-api-key-not-real:")
    expect(ctx.captured.authorization).toBe(
      `Basic ${Buffer.from(`${TEST_API_KEY}:`, "utf-8").toString("base64")}`,
    );
  });

  test("returns null on 404 with the documented error envelope body", async () => {
    const ctx = captureRequest(404, JSON.stringify(missingFixture));
    restore = ctx.restore;

    const result = await lookupByCompanyNumber("99999999", {
      apiKey: TEST_API_KEY,
    });
    expect(result).toBeNull();
  });

  test("translates 401 into CompaniesHouseAuthError", async () => {
    const ctx = captureRequest(401, JSON.stringify({ error: "Unauthorised" }));
    restore = ctx.restore;

    const error = await captureThrown(
      lookupByCompanyNumber("00445790", { apiKey: TEST_API_KEY }),
    );
    expect(error).toBeInstanceOf(CompaniesHouseAuthError);
  });

  test("translates 403 into CompaniesHouseAuthError", async () => {
    const ctx = captureRequest(403, "Forbidden", "text/plain");
    restore = ctx.restore;

    const error = await captureThrown(
      lookupByCompanyNumber("00445790", { apiKey: TEST_API_KEY }),
    );
    expect(error).toBeInstanceOf(CompaniesHouseAuthError);
  });

  test("wraps other non-OK responses as CompaniesHouseAPIError", async () => {
    const ctx = captureRequest(502, "Bad Gateway", "text/plain");
    restore = ctx.restore;

    const error = await captureThrown(
      lookupByCompanyNumber("00445790", { apiKey: TEST_API_KEY }),
    );
    expect(error).toBeInstanceOf(CompaniesHouseAPIError);
    expect(error).toMatchObject({ httpStatus: 502 });
  });
});

describe("searchByName mocked", () => {
  let restore = (): void => {};
  afterEach(() => {
    restore();
  });

  test("parses the Tesco search fixture into 5 hits", async () => {
    const ctx = captureRequest(200, JSON.stringify(searchFixture));
    restore = ctx.restore;

    const results = await searchByName("Tesco", { apiKey: TEST_API_KEY });
    expect(results).toHaveLength(5);
    expect(results[0]?.name).toBe("TESCO PLC");
    expect(ctx.captured.url).toContain("/search/companies?q=Tesco");
    expect(ctx.captured.url).toContain("items_per_page=20");
  });

  test("clamps items_per_page to 100", async () => {
    const ctx = captureRequest(200, JSON.stringify(searchFixture));
    restore = ctx.restore;

    await searchByName("Tesco", { apiKey: TEST_API_KEY }, { limit: 500 });
    expect(ctx.captured.url).toContain("items_per_page=100");
  });

  test("rejects empty search query", async () => {
    const error = await captureThrown(
      searchByName("   ", { apiKey: TEST_API_KEY }),
    );
    expect(error).toBeInstanceOf(CompaniesHouseValidationError);
  });
});

describe("lookupOfficersByCompanyNumber mocked", () => {
  let restore = (): void => {};
  afterEach(() => {
    restore();
  });

  test("returns the parsed officer roster on hit", async () => {
    const ctx = captureRequest(200, JSON.stringify(officersFixture));
    restore = ctx.restore;

    const result = await lookupOfficersByCompanyNumber("00445790", {
      apiKey: TEST_API_KEY,
    });
    expect(result).toHaveLength(4);
    expect(result[0]?.name).toBe("MURPHY, Kenneth Anthony");
    expect(ctx.captured.url).toContain(
      "https://api.company-information.service.gov.uk/company/00445790/officers?",
    );
    expect(ctx.captured.url).toContain("items_per_page=100");
    expect(ctx.captured.url).toContain("start_index=0");
  });

  test("returns [] on 404", async () => {
    const ctx = captureRequest(404, JSON.stringify(missingFixture));
    restore = ctx.restore;

    const result = await lookupOfficersByCompanyNumber("99999999", {
      apiKey: TEST_API_KEY,
    });
    expect(result).toEqual([]);
  });

  test("pages through multiple officer pages when total_results exceeds the page size", async () => {
    // Companies House caps a page at 100 officers; large boards
    // (FTSE 100, complex liquidations) exceed that. Without paging
    // we'd silently truncate the roster.
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const buildItems = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `Officer ${index}`,
        officer_role: "director",
      }));
    const stub = async (input: URL | RequestInfo): Promise<Response> => {
      const url = readRequestUrl(input);
      calls.push(url);
      const startIndex = Number(new URL(url).searchParams.get("start_index"));
      const total = 215;
      const remaining = Math.max(total - startIndex, 0);
      const pageItems = Math.min(remaining, 100);
      return new Response(
        JSON.stringify({
          items: buildItems(pageItems),
          items_per_page: 100,
          start_index: startIndex,
          total_results: total,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    restore = (): void => {
      globalThis.fetch = originalFetch;
    };

    const result = await lookupOfficersByCompanyNumber("00000001", {
      apiKey: TEST_API_KEY,
    });
    expect(result).toHaveLength(215);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("start_index=0");
    expect(calls[1]).toContain("start_index=100");
    expect(calls[2]).toContain("start_index=200");
  });

  test("respects an explicit limit option and stops paging early", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const stub = async (input: URL | RequestInfo): Promise<Response> => {
      const url = readRequestUrl(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          items: Array.from({ length: 100 }, (_, index) => ({
            name: `Officer ${index}`,
            officer_role: "director",
          })),
          items_per_page: 100,
          start_index: 0,
          total_results: 500,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    restore = (): void => {
      globalThis.fetch = originalFetch;
    };

    const result = await lookupOfficersByCompanyNumber(
      "00000001",
      { apiKey: TEST_API_KEY },
      { limit: 50 },
    );
    expect(result).toHaveLength(50);
    expect(calls).toHaveLength(1);
  });
});

// Live smoke tests hit the real Companies House API. Gated on both
// COMPANIES_HOUSE_API_KEY and SMOKE_TEST=1 so they never run in
// unit-test mode.
describe.skipIf(SKIP_LIVE)("Companies House live", () => {
  const config = { apiKey: LIVE_API_KEY ?? TEST_API_KEY };

  test("returns Tesco PLC for company number 00445790", async () => {
    const result = await lookupByCompanyNumber("00445790", config);
    expect(result).not.toBeNull();
    expect(result?.name).toContain("TESCO");
    expect(result?.status.type).toBe("active");
  });

  test("returns null for an unregistered company number", async () => {
    // Use the highest 8-digit number — unlikely to be issued in the
    // foreseeable future.
    const result = await lookupByCompanyNumber("99999998", config);
    expect(result).toBeNull();
  });

  test("name search returns at least one Tesco hit", async () => {
    const results = await searchByName("Tesco", config, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });
});
