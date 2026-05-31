import { afterEach, describe, expect, test } from "bun:test";

import { lookupByIco, searchByName } from "./client.js";
import { OrsrAPIError, OrsrValidationError } from "./errors.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
// SAFETY: fixtures are captured directly from the live ORSR API and
// committed alongside the tests; runtime validation would only
// catch drift between an upstream payload and the committed JSON,
// which is precisely what the assertions below check anyway.
const readFixture = async <T>(name: string): Promise<T> =>
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  (await Bun.file(new URL(name, FIXTURE_DIR)).json()) as T;

type FetchHandler = (input: URL | Request | string) => Promise<Response>;

const installFetchStub = (handler: FetchHandler): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string) => handler(input),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

const urlOf = (input: URL | Request | string): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Live smoke tests — opt-in via SMOKE_TEST=1. Mirror the brreg pattern.
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_LIVE)("lookupByIco live", () => {
  test("returns ESET, spol. s r.o.", async () => {
    const result = await lookupByIco("31333532");
    expect(result).not.toBeNull();
    expect(result?.ico).toBe("31333532");
    expect(result?.name).toContain("ESET");
    expect(result?.registryUrl).toContain("sluzby.orsr.sk");
  }, 15_000);
});

// Name search on `sluzby.orsr.sk` regularly takes 6–8s; bun's default
// 5s test timeout would mark a healthy call as a regression.
const LIVE_SEARCH_TIMEOUT_MS = 15_000;

describe.skipIf(SKIP_LIVE)("searchByName live", () => {
  test(
    "finds entities matching `Telekom`",
    async () => {
      const results = await searchByName("Telekom", { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((entry) => /telekom/iu.test(entry.name))).toBe(true);
    },
    LIVE_SEARCH_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Mocked fetch tests
// ---------------------------------------------------------------------------
describe("lookupByIco (fixture)", () => {
  let restore: () => void = () => {
    // no-op until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // no-op
    };
  });

  test("threads search → extract for ESET and parses the entity", async () => {
    const search = await readFixture<unknown>("search-by-ico-eset.json");
    const extract = await readFixture<unknown>("extract-eset.json");
    let searchCallCount = 0;
    let extractCallCount = 0;
    let lastExtractUrl = "";
    restore = installFetchStub(async (input) => {
      const url = urlOf(input);
      if (url.includes("/extract")) {
        extractCallCount += 1;
        lastExtractUrl = url;
        return jsonResponse(extract);
      }
      searchCallCount += 1;
      return jsonResponse(search);
    });

    const company = await lookupByIco("31333532");
    expect(searchCallCount).toBe(1);
    expect(extractCallCount).toBe(1);
    expect(lastExtractUrl).toContain("oddiel=Sro");
    expect(lastExtractUrl).toContain("vlozka=3586");
    expect(lastExtractUrl).toContain("sud=B");
    expect(company?.ico).toBe("31333532");
    expect(company?.name).toBe("ESET, spol. s r.o.");
    expect(company?.statutoryBodies.length).toBeGreaterThan(0);
  });

  test("parses Volkswagen Slovakia search hit and uses Sa file reference", async () => {
    const search = await readFixture<unknown>("search-by-ico-volkswagen.json");
    const extract = await readFixture<unknown>("extract-eset.json");
    let lastExtractUrl = "";
    restore = installFetchStub(async (input) => {
      const url = urlOf(input);
      if (url.includes("/extract")) {
        lastExtractUrl = url;
      }
      return jsonResponse(url.includes("/extract") ? extract : search);
    });
    await lookupByIco("35757442");
    // Volkswagen Slovakia is filed in the joint-stock register (`Sa`),
    // not the limited-liability register (`Sro`) — proves the adapter
    // wires the search-returned file reference through verbatim
    // instead of hard-coding `Sro`.
    expect(lastExtractUrl).toContain("oddiel=Sa");
    expect(lastExtractUrl).toContain("vlozka=1973");
  });

  test("picks the highest internal id when an IČO has multiple entries", async () => {
    const extract = await readFixture<unknown>("extract-eset.json");
    let lastExtractUrl = "";
    // Synthesise a multi-row search response to exercise the
    // re-registration tiebreaker without depending on an upstream
    // double-registration we don't control.
    const multi = {
      filteredCount: 2,
      data: [
        {
          id: 100,
          fileReference: {
            section: "Sro",
            insertNumber: 999,
            court: "X",
          },
          registrationNumber: "31333532",
          corporateBodyFullName: "ESET (stale row)",
        },
        {
          id: 5994,
          fileReference: {
            section: "Sro",
            insertNumber: 3586,
            court: "B",
          },
          registrationNumber: "31333532",
          corporateBodyFullName: "ESET, spol. s r.o.",
        },
      ],
    };
    restore = installFetchStub(async (input) => {
      const url = urlOf(input);
      if (url.includes("/extract")) {
        lastExtractUrl = url;
        return jsonResponse(extract);
      }
      return jsonResponse(multi);
    });
    await lookupByIco("31333532");
    expect(lastExtractUrl).toContain("vlozka=3586");
    expect(lastExtractUrl).not.toContain("vlozka=999");
  });

  test("returns null when the search yields no hits", async () => {
    const notFound = await readFixture<unknown>("not-found.json");
    restore = installFetchStub(async () => jsonResponse(notFound));
    const company = await lookupByIco("99999986");
    expect(company).toBeNull();
  });

  test("rejects invalid IČOs before any HTTP call", async () => {
    let called = false;
    restore = installFetchStub(async () => {
      called = true;
      return jsonResponse({});
    });
    expect(lookupByIco("12345678")).rejects.toBeInstanceOf(OrsrValidationError);
    expect(called).toBe(false);
  });

  test("surfaces 400 responses as OrsrAPIError", async () => {
    restore = installFetchStub(async () =>
      jsonResponse({ title: "Bad request" }, 400),
    );
    expect(lookupByIco("31333532")).rejects.toMatchObject({
      name: "OrsrAPIError",
      httpStatus: 400,
      upstreamMessage: "Bad request",
    });
  });

  test("surfaces malformed 200 JSON as OrsrAPIError", async () => {
    restore = installFetchStub(
      async () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(lookupByIco("31333532")).rejects.toMatchObject({
      name: "OrsrAPIError",
      httpStatus: 200,
      upstreamMessage: null,
    });
  });
});

describe("searchByName (fixture)", () => {
  let restore: () => void = () => {
    // no-op
  };
  afterEach(() => {
    restore();
    restore = () => {
      // no-op
    };
  });

  test("parses the captured Telekom search page", async () => {
    const body = await readFixture<unknown>("search-by-name.json");
    let lastUrl = "";
    restore = installFetchStub(async (input) => {
      lastUrl = urlOf(input);
      return jsonResponse(body);
    });
    const results = await searchByName("Telekom");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((entry) => entry.name.toLowerCase().includes("telekom")),
    ).toBe(true);
    // The adapter must default to Take=50 so the upstream returns at
    // most a page rather than the entire match set.
    expect(lastUrl).toContain("Take=50");
    expect(lastUrl).toContain("Filter.IncludeTerminated=true");
  });

  test("clamps the limit to the adapter ceiling", async () => {
    const body = await readFixture<unknown>("search-by-name.json");
    let lastUrl = "";
    restore = installFetchStub(async (input) => {
      lastUrl = urlOf(input);
      return jsonResponse(body);
    });
    await searchByName("Telekom", { limit: 5000 });
    expect(lastUrl).toContain("Take=100");
  });

  test("applies the limit client-side when upstream over-returns", async () => {
    restore = installFetchStub(async () =>
      jsonResponse({
        data: Array.from({ length: 3 }, (_, index) => ({
          id: index + 1,
          corporateBodyFullName: `Telekom ${index + 1}`,
          registrationNumber: `1234567${index}`,
        })),
      }),
    );
    const results = await searchByName("Telekom", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  test("de-duplicates re-registration rows by IČO before applying the limit", async () => {
    restore = installFetchStub(async () =>
      jsonResponse({
        data: [
          {
            id: 1,
            corporateBodyFullName: "Telekom stale row",
            registrationNumber: "54303346",
          },
          {
            id: 9,
            corporateBodyFullName: "Telekom current row",
            registrationNumber: "54303346",
          },
          {
            id: 2,
            corporateBodyFullName: "Telekom unique row",
            registrationNumber: "35763469",
          },
        ],
      }),
    );
    const results = await searchByName("Telekom", { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.name)).toEqual([
      "Telekom current row",
      "Telekom unique row",
    ]);
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", () => {
    expect(searchByName("")).rejects.toBeInstanceOf(OrsrValidationError);
    expect(searchByName("   ")).rejects.toBeInstanceOf(OrsrValidationError);
  });
});

// Smoke: ensure the API-error class re-exports cleanly via the client module.
test("exports OrsrAPIError", () => {
  expect(OrsrAPIError).toBeDefined();
});
