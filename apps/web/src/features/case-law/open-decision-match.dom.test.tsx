import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_SEARCH_EXCERPT,
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
  type SearchPageReach,
} from "@stll/api-contract/search";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const originalFetch = globalThis.fetch;
const { QueryClient } = await import("@tanstack/react-query");
const { openDecisionMatch } = await import("./open-decision-match");

const ECLI = "ECLI:CZ:NS:2019:25.CDO.1234.2019.1";

/**
 * The search answering an ECLI with the one decision that carries it, no
 * cursor after it, and the given word on whether its scan reached the page.
 */
const installSearch = (pageReach: SearchPageReach) => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        hits: [
          {
            decisionId: "00000000-0000-4000-8000-000000000001",
            caseNumber: "25 Cdo 1234/2019",
            caseNumberType: "case-number",
            slug: "25-cdo-1234-2019",
            ecli: ECLI,
            identifiers: [{ type: "ecli", value: ECLI }],
            court: "Nejvyšší soud",
            courtAbbreviation: "NS",
            courtTier: "supreme",
            country: "CZ",
            language: "cs",
            languageAlternates: [],
            decisionDate: "2019-05-01",
            decisionType: "rozsudek",
            sourceUrl: null,
            headnote: null,
            headline: null,
            anchorId: null,
            citationCount: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        facets: null,
        nextCursor: null,
        paginationOutcome: SEARCH_PAGINATION_COMPLETE,
        pageReach,
        total: { type: "exact", count: 1 },
        queryUsed: ECLI,
        warnings: [],
      }),
    { preconnect: () => undefined },
  );
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const openWith = async (pageReach: SearchPageReach) => {
  installSearch(pageReach);
  const navigations: unknown[] = [];
  const opened = await openDecisionMatch({
    excerpt: DEFAULT_SEARCH_EXCERPT,
    navigate: async (options) => {
      navigations.push(options);
    },
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
    search: { country: "cz", q: ECLI },
    uiLocale: "cs",
  });
  return { navigations, opened };
};

describe("opening the one decision an entry names", () => {
  test("a page read to the end of its results opens its one match", async () => {
    // The control: the fixture is a match the search would open.
    const { navigations, opened } = await openWith(SEARCH_PAGE_REACH.REACHED);

    expect(opened).toBe(true);
    expect(navigations).toHaveLength(1);
  });

  test("a page whose scan stopped on a budget does not prove the match is the only one", async () => {
    // One match and no cursor, but the scan stopped before the end of the
    // results: another decision under the same reference may follow.
    const { navigations, opened } = await openWith(
      SEARCH_PAGE_REACH.SCAN_BUDGET,
    );

    expect(opened).toBe(false);
    expect(navigations).toEqual([]);
  });
});
