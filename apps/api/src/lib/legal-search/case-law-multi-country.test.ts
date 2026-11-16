import { describe, expect, mock, test } from "bun:test";

import type { PublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
} from "@stll/api-contract/search";
import { compareCodeUnit } from "@stll/collation";

import { status } from "@/api/http/status";
import {
  CASE_LAW_COUNTRIES_CURSOR_MAX_LENGTH,
  type CaseLawCountrySearch,
  decodeCaseLawCountriesCursor,
  encodeCaseLawCountriesCursor,
  hasMoreCountryPages,
  practisedCaseLawCountries,
  practisedCorpusCountries,
  searchCaseLawCountries,
} from "@/api/lib/legal-search/case-law-multi-country";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The per-country fan-out shared by the OpenAI-compatible `search` and the
 * search palette's case-law section. The ranking and quota rules it carries
 * are pinned in `compat-corpus.test.ts`; this suite pins the fan-out itself:
 * what each country is asked, what comes back, and the cursor between pages.
 */

const ADMITTED = asTestRaw<readonly PublicCaseLawCountry[]>([
  "CZE",
  "EU",
  "POL",
  "SVK",
]);
const country = (code: string) => asTestRaw<PublicCaseLawCountry>(code);

type SearchCall = {
  body: { country: string; limit: number; cursor?: string; query: string };
  signal?: AbortSignal;
};

const pageFor = (code: string, nextCursor: string | null) => ({
  hits: [{ decisionId: `decision-${code}`, country: code }],
  nextCursor,
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
});

const searchMock = (
  answer: (call: SearchCall) => unknown = ({ body }) =>
    pageFor(body.country, `${body.country}:next`),
) => {
  const calls: SearchCall[] = [];
  const search = mock(async (call: SearchCall) => {
    calls.push(call);
    return await Promise.resolve(answer(call));
  });
  return { calls, search: asTestRaw<CaseLawCountrySearch>(search) };
};

describe("which countries the palette asks", () => {
  test("only the practised admitted countries, primary first", () => {
    expect(
      practisedCaseLawCountries(
        [
          { alpha3: "POL", isPrimary: false },
          { alpha3: "SVK", isPrimary: true },
          // Not admitted: never asked, and not a reason to ask every country.
          { alpha3: "DEU", isPrimary: false },
        ],
        ADMITTED,
      ),
    ).toEqual(["SVK", "POL"].map(country));
  });

  test("every admitted country, in admitted order, when none is recorded", () => {
    expect(practisedCaseLawCountries([], ADMITTED)).toEqual(ADMITTED);
  });

  test("every admitted country when none of the practised ones is admitted", () => {
    expect(
      practisedCaseLawCountries([{ alpha3: "DEU", isPrimary: true }], ADMITTED),
    ).toEqual(ADMITTED);
  });

  test("practice jurisdictions are read in the corpus's alpha-3 spelling", () => {
    expect(
      practisedCorpusCountries([
        { countryCode: "CZ", isPrimary: true },
        { countryCode: "SK", isPrimary: false },
        asTestRaw<{ countryCode: "CZ"; isPrimary: boolean }>({
          countryCode: "not a country",
          isPrimary: false,
        }),
      ]),
    ).toEqual([
      { alpha3: "CZE", isPrimary: true },
      { alpha3: "SVK", isPrimary: false },
    ]);
  });
});

describe("one page across countries", () => {
  test("each country is asked for its share of the cap, with its own cursor", async () => {
    const { calls, search } = searchMock();
    const controller = new AbortController();
    const outcome = await searchCaseLawCountries({
      query: "náhrada škody",
      countries: [country("CZE"), country("SVK"), country("POL")],
      cursors: { SVK: "SVK:2" },
      cap: 10,
      observer: "unobserved",
      signal: controller.signal,
      search,
    });

    expect(
      calls
        .map(({ body }) => ({
          country: body.country,
          limit: body.limit,
          cursor: body.cursor,
          query: body.query,
        }))
        .toSorted((left, right) =>
          compareCodeUnit(left.country, right.country),
        ),
    ).toEqual([
      { country: "CZE", limit: 4, cursor: undefined, query: "náhrada škody" },
      { country: "POL", limit: 3, cursor: undefined, query: "náhrada škody" },
      { country: "SVK", limit: 3, cursor: "SVK:2", query: "náhrada škody" },
    ]);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
    expect(outcome).toMatchObject({
      type: "page",
      cursors: { CZE: "CZE:next", SVK: "SVK:next", POL: "POL:next" },
      paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    });
    // Hits stay grouped by country, in the order the countries were given.
    expect(
      outcome.type === "page"
        ? outcome.countries.map(({ country: code }) => code)
        : [],
    ).toEqual(["CZE", "SVK", "POL"].map(country));
  });

  test("a country whose pages ended is not asked again and stays ended", async () => {
    const { calls, search } = searchMock();
    const outcome = await searchCaseLawCountries({
      query: "smlouva",
      countries: [country("CZE"), country("SVK")],
      cursors: { CZE: null },
      cap: 10,
      observer: "unobserved",
      search,
    });

    expect(calls.map(({ body }) => body.country)).toEqual(["SVK"]);
    expect(outcome).toMatchObject({
      type: "page",
      cursors: { CZE: null, SVK: "SVK:next" },
    });
  });

  test("a truncated country page marks the merged page truncated", async () => {
    const { search } = searchMock(({ body }) => ({
      ...pageFor(body.country, null),
      paginationOutcome:
        body.country === "SVK"
          ? SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET
          : SEARCH_PAGINATION_COMPLETE,
    }));
    const outcome = await searchCaseLawCountries({
      query: "smlouva",
      countries: [country("CZE"), country("SVK")],
      cursors: {},
      cap: 10,
      observer: "unobserved",
      search,
    });

    expect(outcome).toMatchObject({
      type: "page",
      paginationOutcome: SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
    });
  });

  test("the first country that did not answer sinks the page", async () => {
    const refusal = status(503, { message: "Search index unavailable" });
    const { search } = searchMock(({ body }) =>
      body.country === "SVK" ? refusal : pageFor(body.country, null),
    );
    const outcome = await searchCaseLawCountries({
      query: "smlouva",
      countries: [country("CZE"), country("SVK"), country("POL")],
      cursors: {},
      cap: 10,
      observer: "unobserved",
      search,
    });

    expect(asTestRaw<unknown>(outcome)).toEqual({
      type: "failed",
      country: "SVK",
      answer: refusal,
    });
  });

  test("no countries ask nothing", async () => {
    const { calls, search } = searchMock();
    const outcome = await searchCaseLawCountries({
      query: "smlouva",
      countries: [],
      cursors: {},
      cap: 10,
      observer: "unobserved",
      search,
    });

    expect(calls).toEqual([]);
    expect(outcome).toEqual({
      type: "page",
      countries: [],
      cursors: {},
      paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    });
  });
});

describe("the cursor between pages", () => {
  test("round-trips each country's position, ended ones included", () => {
    const cursors = { CZE: "abc", SVK: null, POL: "def" };
    expect(
      decodeCaseLawCountriesCursor(encodeCaseLawCountriesCursor(cursors)),
    ).toEqual(cursors);
  });

  test("a cursor this module did not mint decodes to null", () => {
    expect(decodeCaseLawCountriesCursor("not-a-cursor")).toBeNull();
    expect(
      decodeCaseLawCountriesCursor(
        Buffer.from(JSON.stringify([{ CZE: 1 }])).toBase64({
          alphabet: "base64url",
          omitPadding: true,
        }),
      ),
    ).toBeNull();
  });

  test("the declared maximum covers every admitted country's position", () => {
    expect(
      encodeCaseLawCountriesCursor({ CZE: "a".repeat(64), SVK: null }).length,
    ).toBeLessThan(CASE_LAW_COUNTRIES_CURSOR_MAX_LENGTH);
  });

  test("more pages remain while any country has a position", () => {
    expect(hasMoreCountryPages({ CZE: null, SVK: "x" })).toBe(true);
    expect(hasMoreCountryPages({ CZE: null, SVK: null })).toBe(false);
    expect(hasMoreCountryPages({})).toBe(false);
  });
});
