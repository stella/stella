import type { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { lookupByIco, searchByName } from "./client.js";
import type { RpoClientError } from "./client.js";
import { RpoAPIError, RpoRequestError, RpoValidationError } from "./errors.js";
import type { RpoRawSearchResponse } from "./types.js";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);

// SAFETY: fixtures are captured from the live RPO API and committed beside
// the tests; the assertions below check the parsed shape.
const readFixture = async <T>(name: string): Promise<T> =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- committed test fixture JSON; shape asserted by the tests below
  (await Bun.file(new URL(name, FIXTURE_DIR)).json()) as T;

type FetchHandler = (url: URL) => Promise<Response>;

const urlOf = (input: URL | Request | string): URL =>
  new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );

const installFetchStub = (handler: FetchHandler): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string) => handler(urlOf(input)),
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

const isEntityRequest = (url: URL): boolean =>
  url.pathname.startsWith("/rpo/v1/entity/");

const errorOf = async (
  pending: Promise<Result<unknown, RpoClientError>>,
): Promise<RpoClientError | null> => {
  const result = await pending;
  return result.isErr() ? result.error : null;
};

let restore: () => void = () => {
  // replaced by each test's stub
};
afterEach(() => {
  restore();
});

describe("lookupByIco", () => {
  test("finds the record by IČO, then reads its current view", async () => {
    const search = await readFixture<unknown>("search-by-ico-eset.json");
    const entity = await readFixture<unknown>("entity-eset.json");
    const requests: URL[] = [];
    restore = installFetchStub(async (url) => {
      requests.push(url);
      return jsonResponse(isEntityRequest(url) ? entity : search);
    });

    const result = (await lookupByIco("31 333 532")).unwrap();

    expect(requests.map((url) => url.pathname)).toEqual([
      "/rpo/v1/search",
      "/rpo/v1/entity/937053",
    ]);
    expect(requests[0]?.searchParams.get("identifier")).toBe("31333532");
    expect(requests[1]?.searchParams.has("showHistoricalData")).toBe(false);
    expect(result?.name).toBe("ESET, spol. s r.o.");
    // The current view has one seat; the search row supplies the history.
    expect(result?.address?.street).toBe("Einsteinova 24");
    expect(result?.formerAddresses.map(({ value }) => value.street)).toEqual([
      "Pionierska 9/A",
      "Ondavská 3",
    ]);
  });

  test("asks for historical data in the historical view", async () => {
    const search = await readFixture<unknown>("search-by-ico-eset.json");
    const entity = await readFixture<unknown>("entity-eset-historical.json");
    let entityUrl: URL | null = null;
    restore = installFetchStub(async (url) => {
      if (isEntityRequest(url)) {
        entityUrl = url;
        return jsonResponse(entity);
      }
      return jsonResponse(search);
    });

    const result = (
      await lookupByIco("31333532", { view: "historical" })
    ).unwrap();

    expect(entityUrl?.searchParams.get("showHistoricalData")).toBe("true");
    expect(
      result?.statutoryBodies.some(({ validTo }) => validTo !== null),
    ).toBe(true);
  });

  test("names a terminated entity from its search row", async () => {
    const { results } = await readFixture<RpoRawSearchResponse>(
      "search-by-name-slovnaft.json",
    );
    const search = { results: results.filter(({ id }) => id === 297_265) };
    const entity = await readFixture<unknown>("entity-terminated.json");
    restore = installFetchStub(async (url) =>
      jsonResponse(isEntityRequest(url) ? entity : search),
    );

    const result = (await lookupByIco("35681039")).unwrap();

    expect(result).toMatchObject({
      name: "Slovnaft Retail, s.r.o.",
      status: { type: "terminated", terminatedAt: "2023-07-05" },
      statutoryBodies: [],
      successors: [
        { ico: "31322832", name: "SLOVNAFT, a.s.", validFrom: "2023-07-05" },
      ],
    });
    expect(result?.formerNames.length).toBeGreaterThan(0);
    expect(result?.legalStatuses).toContain("Zaniknutá spoločnosť");
  });

  test("prefers the record still in existence when an IČO has several", async () => {
    const { results } = await readFixture<RpoRawSearchResponse>(
      "search-by-ico-eset.json",
    );
    const live = results.at(0);
    if (!live) {
      throw new Error("ESET search fixture must hold a row");
    }
    const ended = { ...live, id: live.id + 1, termination: "2000-01-01" };
    const entity = await readFixture<unknown>("entity-eset.json");
    let entityPath = "";
    restore = installFetchStub(async (url) => {
      if (isEntityRequest(url)) {
        entityPath = url.pathname;
        return jsonResponse(entity);
      }
      return jsonResponse({ results: [ended, live] });
    });

    (await lookupByIco("31333532")).unwrap();

    expect(entityPath).toBe(`/rpo/v1/entity/${live.id}`);
  });

  test("returns null without an entity request when no row carries the IČO", async () => {
    const university = await readFixture<unknown>(
      "search-by-ico-public-university.json",
    );
    const requests: URL[] = [];
    restore = installFetchStub(async (url) => {
      requests.push(url);
      return jsonResponse(university);
    });

    expect((await lookupByIco("31333532")).unwrap()).toBeNull();
    expect(requests.some(isEntityRequest)).toBe(false);
  });

  test("returns null when the entity record is gone", async () => {
    const search = await readFixture<unknown>("search-by-ico-eset.json");
    const notFound = await readFixture<unknown>("entity-not-found.json");
    restore = installFetchStub(async (url) =>
      isEntityRequest(url) ? jsonResponse(notFound, 404) : jsonResponse(search),
    );

    expect((await lookupByIco("31333532")).unwrap()).toBeNull();
  });

  test("accepts IČOs that predate the check digit", async () => {
    let searched = "";
    restore = installFetchStub(async (url) => {
      searched = url.searchParams.get("identifier") ?? "";
      return jsonResponse({ results: [] });
    });

    // 11111111 fails MOD-11 yet is a registered 1992 state enterprise.
    expect((await lookupByIco("11111111")).unwrap()).toBeNull();
    expect(searched).toBe("11111111");
  });

  test("rejects input that is not eight digits before any request", async () => {
    let called = false;
    restore = installFetchStub(async () => {
      called = true;
      return jsonResponse({ results: [] });
    });

    for (const input of ["3133353", "313335322", "ESET"]) {
      expect(await errorOf(lookupByIco(input))).toBeInstanceOf(
        RpoValidationError,
      );
    }
    expect(called).toBe(false);
  });
});

describe("upstream failures", () => {
  test("an HTML page served with HTTP 200 is an API error", async () => {
    restore = installFetchStub(
      async () =>
        new Response("<html><body>Služba je nedostupná</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );

    expect((await errorOf(lookupByIco("31333532")))?.message).toBe(
      "RPO 200: invalid JSON payload",
    );
  });

  test("a rejected request carries the register's message", async () => {
    const body = await readFixture<unknown>("search-no-parameters.json");
    restore = installFetchStub(async () => jsonResponse(body, 400));

    const rejection = await errorOf(searchByName("ESET"));

    expect(rejection).toBeInstanceOf(RpoAPIError);
    expect(rejection).toMatchObject({
      httpStatus: 400,
      upstreamMessage: "No parameters specified in search request",
    });
  });

  test("a 5xx outage page is an API error with its status", async () => {
    restore = installFetchStub(
      async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
    );

    expect(await errorOf(searchByName("ESET"))).toMatchObject({
      name: "RpoAPIError",
      httpStatus: 502,
      upstreamMessage: null,
    });
  });

  test("a transport failure is a request error", async () => {
    restore = installFetchStub(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await errorOf(lookupByIco("31333532"))).toBeInstanceOf(
      RpoRequestError,
    );
  });

  test("an unexpected JSON shape is an API error", async () => {
    restore = installFetchStub(async () => jsonResponse({ data: [] }));

    expect((await errorOf(searchByName("ESET")))?.message).toContain(
      "unexpected JSON payload shape",
    );
  });

  test("a null nested entry is an API error", async () => {
    restore = installFetchStub(async () =>
      jsonResponse({ results: [{ id: 1, identifiers: [null] }] }),
    );

    expect(await errorOf(lookupByIco("31333532"))).toBeInstanceOf(RpoAPIError);
  });

  test("a malformed leaf field is an API error", async () => {
    restore = installFetchStub(async () =>
      jsonResponse({
        results: [
          {
            id: 1,
            identifiers: [{ value: "31333532" }],
            fullNames: [{ value: { text: "ESET" } }],
          },
        ],
      }),
    );

    expect((await errorOf(searchByName("ESET")))?.message).toContain(
      "unexpected JSON payload shape",
    );
  });
});

describe("searchByName", () => {
  test("ranks whole-name matches and live entities first", async () => {
    const fixture = await readFixture<RpoRawSearchResponse>(
      "search-by-name-slovnaft.json",
    );
    let fullName = "";
    restore = installFetchStub(async (url) => {
      fullName = url.searchParams.get("fullName") ?? "";
      return jsonResponse(fixture);
    });

    const results = (await searchByName(" slovnaft ", { limit: 100 })).unwrap();

    expect(fullName).toBe("slovnaft");
    // Every upstream row survives the ranking.
    expect(results.map(({ rpoId }) => rpoId).toSorted()).toEqual(
      fixture.results.map(({ id }) => id).toSorted(),
    );
    const first = results.at(0);
    expect(first?.name.toLowerCase()).toStartWith("slovnaft");
    expect(first?.status.type).toBe("active");
    // A row whose name lacks the query never outranks one that has it,
    // matched regardless of case and diacritics ("Slovnafť").
    const hasQuery = results.map(({ name }) =>
      name
        .normalize("NFD")
        .replaceAll(/\p{M}/gu, "")
        .toLowerCase()
        .includes("slovnaft"),
    );
    expect(hasQuery).toContain(false);
    expect(hasQuery.indexOf(false)).toBeGreaterThan(hasQuery.lastIndexOf(true));
  });

  test("applies the limit after ranking", async () => {
    const fixture = await readFixture<RpoRawSearchResponse>(
      "search-by-name-slovnaft.json",
    );
    restore = installFetchStub(async () => jsonResponse(fixture));

    const all = (await searchByName("slovnaft", { limit: 100 })).unwrap();
    const top = (await searchByName("slovnaft", { limit: 3 })).unwrap();

    expect(top).toEqual(all.slice(0, 3));
  });

  test("rejects an empty name", async () => {
    expect(await errorOf(searchByName("   "))).toBeInstanceOf(
      RpoValidationError,
    );
  });
});
