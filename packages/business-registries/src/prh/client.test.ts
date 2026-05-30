import { afterEach, describe, expect, test } from "bun:test";

import { lookupByBusinessId, searchByName } from "./client.js";
import { PrhAPIError, PrhValidationError } from "./errors.js";
import type { PrhCompaniesResponse } from "./types.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const readFixture = async (name: string): Promise<PrhCompaniesResponse> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are captured directly from the live PRH API and
  // committed alongside the tests; runtime validation here would only
  // catch drift between an upstream payload and the committed JSON,
  // which is precisely what the assertions below check anyway.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as PrhCompaniesResponse;
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

// ---------------------------------------------------------------------------
// Live tests — opt-in. Mirror the brreg pattern.
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_LIVE)("lookupByBusinessId live", () => {
  test("returns Nokia Oyj", async () => {
    const result = await lookupByBusinessId("0112038-9");
    expect(result).not.toBeNull();
    expect(result?.businessId).toBe("0112038-9");
    expect(result?.name.toUpperCase()).toContain("NOKIA");
    expect(result?.registryUrl).toContain("0112038-9");
  });
});

describe.skipIf(SKIP_LIVE)("searchByName live", () => {
  test("finds Supercell Oy", async () => {
    const results = await searchByName("Supercell", { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((entry) => entry.name.toUpperCase().includes("SUPERCELL")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mocked fetch tests using captured upstream fixtures.
// ---------------------------------------------------------------------------
describe("lookupByBusinessId (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the live Nokia payload", async () => {
    const body = await readFixture("lookup-nokia.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupByBusinessId("0112038-9");
    expect(company).not.toBeNull();
    expect(company?.businessId).toBe("0112038-9");
    expect(company?.name).toBe("Nokia Oyj");
    expect(company?.legalForm).toBe("Public limited company");
    expect(company?.legalFormCode).toBe("17");
    expect(company?.mainBusinessLine).toEqual({
      code: "70100",
      description: "Activities of head offices",
    });
    expect(company?.status).toEqual({ type: "registered" });
    expect(company?.tradeRegisterRegistered).toBe(true);
    // Parallel names + trade names round-trip without the primary
    // "Nokia Oyj" entry duplicating itself.
    expect(
      company?.alternateNames.some((entry) => entry.name === "Nokia Oyj"),
    ).toBe(false);
    expect(
      company?.alternateNames.some(
        (entry) => entry.name === "Nokia Corporation" && entry.isCurrent,
      ),
    ).toBe(true);
  });

  test("returns null when PRH yields totalResults: 0", async () => {
    const body = await readFixture("lookup-not-found.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupByBusinessId("0112038-9");
    expect(company).toBeNull();
  });

  test("surfaces 400 errors as PrhAPIError", async () => {
    restore = installFetchStub(
      async () =>
        new Response(
          JSON.stringify({
            timestamp: "2026-01-01T00:00:00",
            message: "Parameter businessId is missing",
            errorcode: 1005,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    expect(lookupByBusinessId("0112038-9")).rejects.toMatchObject({
      name: "PrhAPIError",
      httpStatus: 400,
      upstreamCode: 1005,
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

  test("parses the live Supercell search page", async () => {
    const body = await readFixture("search-supercell.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const results = await searchByName("Supercell");
    expect(results.length).toBeGreaterThan(0);
    const supercell = results.find((entry) => entry.name === "Supercell Oy");
    expect(supercell).toBeDefined();
    expect(supercell?.businessId).toBe("2336509-6");
    expect(supercell?.address).toContain("HELSINKI");
  });

  test("applies the limit option client-side", async () => {
    const body = await readFixture("search-supercell.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const results = await searchByName("Supercell", { limit: 1 });
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("lookupByBusinessId validation", () => {
  test("rejects format violations", () => {
    expect(lookupByBusinessId("01120389")).rejects.toBeInstanceOf(
      PrhValidationError,
    );
    expect(lookupByBusinessId("abcdefg-1")).rejects.toBeInstanceOf(
      PrhValidationError,
    );
  });

  test("rejects bad checksum", () => {
    // 0112038-9 is valid; bump the check digit and it should fail.
    expect(lookupByBusinessId("0112038-0")).rejects.toBeInstanceOf(
      PrhValidationError,
    );
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", () => {
    expect(searchByName("")).rejects.toBeInstanceOf(PrhValidationError);
    expect(searchByName("  ")).rejects.toBeInstanceOf(PrhValidationError);
  });
});

// Smoke: PrhAPIError export is reachable via barrel for consumers that
// only import from the package root.
test("exports PrhAPIError", () => {
  expect(PrhAPIError).toBeDefined();
});
