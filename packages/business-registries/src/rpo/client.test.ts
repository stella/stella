import { afterEach, describe, expect, test } from "bun:test";

import { lookupByIco, searchByName } from "./client.js";
import { RpoAPIError, RpoValidationError } from "./errors.js";
import type { RpoRawEntity, RpoSearchResponse } from "./types.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);

const readFixture = async <T>(name: string): Promise<T> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are captured directly from the live RPO API and
  // committed alongside the tests; runtime validation here would only
  // catch drift between an upstream payload and the committed JSON,
  // which is precisely what the assertions below check anyway.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as T;
};

type FetchHandler = (input: URL | Request | string) => Promise<Response>;

const fetchInputToString = (input: URL | Request | string): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const installFetchStub = (handler: FetchHandler) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string) => handler(input),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

// ---------------------------------------------------------------------------
// Live tests — opt-in. Mirror the brreg/prh pattern.
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_LIVE)("lookupByIco live", () => {
  test("returns ESET, spol. s r.o.", async () => {
    const result = await lookupByIco("31333532");
    expect(result).not.toBeNull();
    expect(result?.ico).toBe("31333532");
    expect(result?.name.toUpperCase()).toContain("ESET");
    expect(result?.registryUrl).toContain("/entity/");
  });
});

describe.skipIf(SKIP_LIVE)("searchByName live", () => {
  test("finds Slovak Telekom", async () => {
    const results = await searchByName("Slovak Telekom", { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((entry) =>
        entry.name.toUpperCase().includes("SLOVAK TELEKOM"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mocked fetch tests using captured upstream fixtures.
// ---------------------------------------------------------------------------
describe("lookupByIco (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the live ESET payload via the two-step search + entity flow", async () => {
    const searchBody = await readFixture<RpoSearchResponse>(
      "lookup-eset-search.json",
    );
    const entityBody = await readFixture<RpoRawEntity>(
      "lookup-eset-entity.json",
    );
    restore = installFetchStub(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/search?")) {
        return jsonResponse(searchBody);
      }
      if (url.includes("/entity/")) {
        return jsonResponse(entityBody);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const company = await lookupByIco("31333532");
    expect(company).not.toBeNull();
    expect(company?.ico).toBe("31333532");
    expect(company?.name).toBe("ESET, spol. s r.o.");
    expect(company?.legalForm).toBe("Spoločnosť s ručením obmedzeným");
    expect(company?.legalFormCode).toBe("112");
    expect(company?.status).toEqual({ type: "registered" });
    expect(company?.establishedAt).toBe("1992-09-17");
    expect(company?.address?.street).toBe("Einsteinova 24");
    expect(company?.address?.city).toBe("Bratislava");
    expect(company?.address?.postalCode).toBe("85101");
    expect(company?.courtFile).toEqual({
      court: "Mestský súd Bratislava III",
      fileNumber: "Sro/3586/B",
    });
    expect(company?.mainActivity?.code).toBe("6290");
    expect(company?.activities.length).toBeGreaterThan(0);
    expect(company?.statutoryBodies.length).toBeGreaterThan(0);
    expect(company?.registryUrl).toBe(
      "https://rpo.statistics.sk/rpo/v1/entity/937053",
    );
  });

  test("returns null when RPO yields an empty results array", async () => {
    const body = await readFixture<RpoSearchResponse>("lookup-not-found.json");
    restore = installFetchStub(async () => jsonResponse(body));

    const company = await lookupByIco("99999901");
    expect(company).toBeNull();
  });

  test("surfaces 400 errors as RpoAPIError", async () => {
    restore = installFetchStub(async () =>
      jsonResponse({ code: 400, message: "Bad request" }, { status: 400 }),
    );

    expect(lookupByIco("31333532")).rejects.toMatchObject({
      name: "RpoAPIError",
      httpStatus: 400,
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

  test("parses the live Slovak Telekom search page", async () => {
    const body = await readFixture<RpoSearchResponse>("search-telekom.json");
    restore = installFetchStub(async () => jsonResponse(body));

    const results = await searchByName("Slovak Telekom");
    expect(results.length).toBeGreaterThan(0);
    const telekom = results.find(
      (entry) => entry.name === "Slovak Telekom, a.s.",
    );
    expect(telekom).toBeDefined();
    expect(telekom?.ico).toBe("35763469");
    expect(telekom?.address).toContain("Bratislava");
  });

  test("applies the limit option client-side", async () => {
    const body = await readFixture<RpoSearchResponse>("search-telekom.json");
    restore = installFetchStub(async () => jsonResponse(body));

    const results = await searchByName("Slovak Telekom", { limit: 1 });
    expect(results).toHaveLength(1);
  });

  test("threads onlyActive=false through to the upstream query", async () => {
    let capturedUrl = "";
    restore = installFetchStub(async (input) => {
      capturedUrl = fetchInputToString(input);
      return jsonResponse({ results: [] });
    });

    await searchByName("Slovak Telekom", { onlyActive: false });
    expect(capturedUrl).toContain("onlyActive=false");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("lookupByIco validation", () => {
  test("rejects format violations", () => {
    expect(lookupByIco("123")).rejects.toBeInstanceOf(RpoValidationError);
    expect(lookupByIco("ABCDEFGH")).rejects.toBeInstanceOf(RpoValidationError);
  });

  test("rejects bad checksum", () => {
    // 35763469 is valid; bump the check digit and it should fail.
    expect(lookupByIco("35763460")).rejects.toBeInstanceOf(RpoValidationError);
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", () => {
    expect(searchByName("")).rejects.toBeInstanceOf(RpoValidationError);
    expect(searchByName("  ")).rejects.toBeInstanceOf(RpoValidationError);
  });
});

// Smoke: RpoAPIError export is reachable via barrel for consumers that
// only import from the package root.
test("exports RpoAPIError", () => {
  expect(RpoAPIError).toBeDefined();
});
