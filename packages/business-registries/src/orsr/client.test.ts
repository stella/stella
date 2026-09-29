import { afterEach, describe, expect, test } from "bun:test";

import { lookupByIco, lookupFullRecordByIco, searchByName } from "./client.js";
import { OrsrValidationError } from "./errors.js";
import type { OrsrRawRelatedResponse } from "./types.js";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
// SAFETY: fixtures are captured directly from the live ORSR API and
// committed alongside the tests; runtime validation would only
// catch drift between an upstream payload and the committed JSON,
// which is precisely what the assertions below check anyway.
const readFixture = async <T>(name: string): Promise<T> =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- committed test fixture JSON; shape asserted by the tests below
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

// The ESET extract relabelled with another IČO, for search fixtures that
// have no extract of their own.
const withExtractIco = (extract: unknown, ico: string): unknown =>
  JSON.parse(JSON.stringify(extract).replaceAll("31333532", () => ico));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

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
    const extract = withExtractIco(
      await readFixture<unknown>("extract-eset.json"),
      "35757442",
    );
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

  test("ignores name matches whose IČO differs from the requested one", async () => {
    const extract = await readFixture<unknown>("extract-eset.json");
    let lastExtractUrl = "";
    // The search filter also matches corporate names, so a newer company
    // named after the target's IČO comes back with a higher internal id.
    const withNameMatch = {
      filteredCount: 2,
      data: [
        {
          id: 5994,
          fileReference: { section: "Sro", insertNumber: 3586, court: "B" },
          registrationNumber: "31333532",
          corporateBodyFullName: "ESET, spol. s r.o.",
        },
        {
          id: 999_999,
          fileReference: { section: "Sro", insertNumber: 777, court: "B" },
          registrationNumber: "54303346",
          corporateBodyFullName: "31333532 s.r.o.",
        },
      ],
    };
    restore = installFetchStub(async (input) => {
      const url = urlOf(input);
      if (url.includes("/extract")) {
        lastExtractUrl = url;
        return jsonResponse(extract);
      }
      return jsonResponse(withNameMatch);
    });
    const company = await lookupByIco("31333532");
    expect(lastExtractUrl).toContain("vlozka=3586");
    expect(company?.ico).toBe("31333532");
  });

  test("returns null when no hit carries the requested IČO", async () => {
    let extractCalled = false;
    restore = installFetchStub(async (input) => {
      if (urlOf(input).includes("/extract")) {
        extractCalled = true;
      }
      return jsonResponse({
        filteredCount: 1,
        data: [
          {
            id: 1,
            fileReference: { section: "Sro", insertNumber: 1, court: "B" },
            registrationNumber: "54303346",
            corporateBodyFullName: "31333532 s.r.o.",
          },
        ],
      });
    });
    expect(await lookupByIco("31333532")).toBeNull();
    expect(extractCalled).toBe(false);
  });

  test("returns null for an extract that names a different IČO", async () => {
    const search = await readFixture<unknown>("search-by-ico-eset.json");
    const extract = withExtractIco(
      await readFixture<unknown>("extract-eset.json"),
      "35757442",
    );
    restore = installFetchStub(async (input) =>
      jsonResponse(urlOf(input).includes("/extract") ? extract : search),
    );
    expect(await lookupByIco("31333532")).toBeNull();
  });

  test("ignores hits whose registration number is not a string", async () => {
    let extractCalled = false;
    restore = installFetchStub(async (input) => {
      if (urlOf(input).includes("/extract")) {
        extractCalled = true;
      }
      return jsonResponse({
        filteredCount: 1,
        data: [
          {
            id: 1,
            fileReference: { section: "Sro", insertNumber: 1, court: "B" },
            registrationNumber: null,
            corporateBodyFullName: "31333532 s.r.o.",
          },
        ],
      });
    });
    expect(await lookupByIco("31333532")).toBeNull();
    expect(extractCalled).toBe(false);
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

  test("rejects non-string court names in successful extract payloads", async () => {
    const search = await readFixture<unknown>("search-by-ico-eset.json");
    let malformedCourtName: unknown;
    restore = installFetchStub(async (input) =>
      jsonResponse(
        urlOf(input).includes("/extract")
          ? { legalPerson: {}, courtName: malformedCourtName }
          : search,
      ),
    );

    for (const value of [null, 42, false, {}, []]) {
      malformedCourtName = value;
      const rejection: unknown = await lookupByIco("31333532").then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toMatchObject({
        name: "OrsrAPIError",
        httpStatus: 200,
        upstreamMessage: null,
      });
    }
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

// Stub keyed on the request path, with the request's init for its signal.
const installPathStub = (
  handler: (url: URL, init?: RequestInit) => Promise<Response>,
): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string, init?: RequestInit) =>
      handler(new URL(urlOf(input)), init),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

const rejectionOf = async (pending: Promise<unknown>): Promise<unknown> =>
  await pending.then(
    () => null,
    (error: unknown) => error,
  );

describe("lookupFullRecordByIco", () => {
  let restore: () => void = () => {
    // replaced by each test's stub
  };
  afterEach(() => {
    restore();
  });

  const eset = async () => ({
    search: await readFixture<unknown>("search-by-ico-eset.json"),
    extract: await readFixture<unknown>("extract-eset.json"),
    full: await readFixture<unknown>("extract-full-eset.json"),
    documents: await readFixture<unknown>("documents-eset.json"),
    related: await readFixture<OrsrRawRelatedResponse>("related-empty.json"),
  });

  test("reads the extract, history, documents, and links of one file", async () => {
    const fixtures = await eset();
    const paths: string[] = [];
    restore = installPathStub(async (url) => {
      paths.push(url.pathname);
      switch (url.pathname) {
        case "/api/legal-person/extract":
          return jsonResponse(fixtures.extract);
        case "/api/legal-person/extract-full":
          return jsonResponse(fixtures.full);
        case "/api/legal-person/documents":
          return jsonResponse(fixtures.documents);
        case "/api/legal-person/related":
          expect(url.searchParams.get("oddiel")).toBe("Sro");
          expect(url.searchParams.get("vlozka")).toBe("3586");
          expect(url.searchParams.get("sud")).toBe("B");
          return jsonResponse(fixtures.related);
        default:
          return jsonResponse(fixtures.search);
      }
    });

    const record = await lookupFullRecordByIco("31333532");

    expect(paths.toSorted()).toEqual([
      "/api/legal-person",
      "/api/legal-person/documents",
      "/api/legal-person/extract",
      "/api/legal-person/extract-full",
      "/api/legal-person/related",
    ]);
    expect(record?.company.name).toBe("ESET, spol. s r.o.");
    expect(record?.history.status).toBe("loaded");
    expect(record?.documents).toMatchObject({ status: "loaded" });
    if (record?.documents.status === "loaded") {
      expect(
        record.documents.value.map(({ serialNumber }) => serialNumber),
      ).toEqual([185, 181, 182, 156]);
    }
    expect(record?.related).toEqual({ status: "loaded", value: [] });
  });

  test("a failed supplementary part is reported, not fatal", async () => {
    const fixtures = await eset();
    restore = installPathStub(async (url) => {
      switch (url.pathname) {
        case "/api/legal-person/extract":
          return jsonResponse(fixtures.extract);
        case "/api/legal-person/extract-full":
          return new Response("<html>Služba nedostupná</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        case "/api/legal-person/documents":
          return new Response("Bad Gateway", { status: 502 });
        case "/api/legal-person/related":
          throw new TypeError("fetch failed");
        default:
          return jsonResponse(fixtures.search);
      }
    });

    const record = await lookupFullRecordByIco("31333532");

    expect(record?.company.ico).toBe("31333532");
    expect(record?.history).toEqual({
      status: "unavailable",
      reason: "ORSR 200: invalid JSON payload",
    });
    expect(record?.documents).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("ORSR 502"),
    });
    expect(record?.related).toEqual({
      status: "unavailable",
      reason: "ORSR request failed",
    });
  });

  test("a malformed document row marks the documents unavailable", async () => {
    const fixtures = await eset();
    restore = installPathStub(async (url) => {
      switch (url.pathname) {
        case "/api/legal-person/extract":
          return jsonResponse(fixtures.extract);
        case "/api/legal-person/extract-full":
          return jsonResponse(fixtures.full);
        case "/api/legal-person/documents":
          return jsonResponse([{ serialNumber: 1, name: 5 }]);
        case "/api/legal-person/related":
          return jsonResponse(fixtures.related);
        default:
          return jsonResponse(fixtures.search);
      }
    });

    const record = await lookupFullRecordByIco("31333532");

    expect(record?.company.ico).toBe("31333532");
    expect(record?.documents).toEqual({
      status: "unavailable",
      reason: "ORSR 200: unexpected JSON payload shape",
    });
  });

  test("a malformed related row marks the links unavailable", async () => {
    const fixtures = await eset();
    restore = installPathStub(async (url) => {
      switch (url.pathname) {
        case "/api/legal-person/extract":
          return jsonResponse(fixtures.extract);
        case "/api/legal-person/extract-full":
          return jsonResponse(fixtures.full);
        case "/api/legal-person/documents":
          return jsonResponse(fixtures.documents);
        case "/api/legal-person/related":
          return jsonResponse({ data: [{ corporateBodyFullName: 7 }] });
        default:
          return jsonResponse(fixtures.search);
      }
    });

    const record = await lookupFullRecordByIco("31333532");

    expect(record?.documents).toMatchObject({ status: "loaded" });
    expect(record?.related).toEqual({
      status: "unavailable",
      reason: "ORSR 200: unexpected JSON payload shape",
    });
  });

  test("an outage page instead of the extract fails the lookup", async () => {
    const fixtures = await eset();
    restore = installPathStub(async (url) =>
      url.pathname === "/api/legal-person"
        ? jsonResponse(fixtures.search)
        : new Response("<html>Údržba</html>", { status: 200 }),
    );

    expect(await rejectionOf(lookupFullRecordByIco("31333532"))).toMatchObject({
      name: "OrsrAPIError",
      message: "ORSR 200: invalid JSON payload",
    });
  });

  test("caller cancellation propagates instead of marking parts unavailable", async () => {
    const fixtures = await eset();
    const controller = new AbortController();
    // The extract and history answer; the caller cancels while the
    // supplementary documents request is in flight.
    restore = installPathStub(async (url, init) => {
      switch (url.pathname) {
        case "/api/legal-person":
          return jsonResponse(fixtures.search);
        case "/api/legal-person/extract":
          return jsonResponse(fixtures.extract);
        case "/api/legal-person/extract-full":
          return jsonResponse(fixtures.full);
        default:
          controller.abort(new Error("caller went away"));
          init?.signal?.throwIfAborted();
          return jsonResponse(fixtures.related);
      }
    });

    expect(
      await rejectionOf(
        lookupFullRecordByIco("31333532", { signal: controller.signal }),
      ),
    ).toMatchObject({ message: "caller went away" });
  });

  test("returns null without file requests when the IČO is not on file", async () => {
    const paths: string[] = [];
    restore = installPathStub(async (url) => {
      paths.push(url.pathname);
      return jsonResponse({ filteredCount: 0, data: [] });
    });

    expect(await lookupFullRecordByIco("31333532")).toBeNull();
    expect(paths).toEqual(["/api/legal-person"]);
  });

  test("rejects an invalid IČO before any request", async () => {
    let called = false;
    restore = installPathStub(async () => {
      called = true;
      return jsonResponse({});
    });

    expect(await rejectionOf(lookupFullRecordByIco("12345678"))).toBeInstanceOf(
      OrsrValidationError,
    );
    expect(called).toBe(false);
  });
});
