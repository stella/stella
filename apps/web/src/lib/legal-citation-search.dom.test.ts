import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
} from "@stll/api-contract/search";

import type { api } from "@/lib/api";
import type { PublicLawData } from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const originalFetch = globalThis.fetch;
const { QueryClient } = await import("@tanstack/react-query");
const { openDecisionMatch, readDecisionMatch } =
  await import("@/features/case-law/open-decision-match");
const { openStatuteMatch } =
  await import("@/features/statutes/open-statute-match");
const { isLegalCitationSearch, readLegalCitationSearch } =
  await import("./legal-citation-search");

const { citationCommandHits, citationCommandRoute } =
  await import("@/components/search-citation-results");

type DecisionSearchResponse = PublicLawData<
  typeof api.case.decisions.search.post
>;
type StatutesResponse = PublicLawData<typeof api.law.statutes.get>;

const docket = "22 As 40/2025";
const docketWithSheet = `${docket} - 49`;
const ecli = "ECLI:CZ:NS:2019:25.CDO.1234.2019.1";
const decision = {
  decisionId: "00000000-0000-4000-8000-000000000049",
  caseNumber: docket,
  caseNumberType: "case-number",
  slug: "22-as-40-2025-49",
  ecli: null,
  // The API's projected case-number identifier retains the publisher's sheet
  // spelling even though the row's primary caseNumber is the bare file.
  identifiers: [{ type: "case-number", value: docketWithSheet }],
  court: "Nejvyšší správní soud",
  courtAbbreviation: "NSS",
  courtTier: "supreme",
  country: "CZ",
  language: "cs",
  languageAlternates: [],
  decisionDate: "2025-05-01",
  decisionType: "rozsudek",
  sourceUrl: null,
  headnote: null,
  headline: null,
  keywords: null,
  textWithheldReason: null,
  citationAuthority: 0,
  matchingPassages: 1,
  match: "all_terms",
  anchorId: null,
  citationCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies DecisionSearchResponse["hits"][number];

const ecliDecision = {
  ...decision,
  decisionId: "00000000-0000-4000-8000-000000000050",
  caseNumber: "25 Cdo 1234/2019",
  caseNumberType: "case-number",
  slug: "25-cdo-1234-2019",
  ecli,
  identifiers: [{ type: "ecli", value: ecli }],
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
} satisfies DecisionSearchResponse["hits"][number];

const statute = {
  amendmentCount: 0,
  citationCaseCount: null,
  country: "CZE",
  documentType: "zákon",
  documentUrl: null,
  effectiveDate: "2012-01-01",
  eli: "/eli/cz/sb/2012/89",
  firstVersionValidFrom: "2012-01-01",
  id: toSafeId<"legislationDocument">("00000000-0000-4000-8000-000000000089"),
  language: "cs",
  lastAmendedOn: null,
  slug: "89-2012-sb-obcansky-zakonik",
  sourceUrl: null,
  status: "current",
  title: "89/2012 Sb., občanský zákoník",
  validity: "in-force",
  versionValidFrom: "2012-01-01",
  versionValidTo: null,
} satisfies StatutesResponse["items"][number];

const decisionPage = (hits: DecisionSearchResponse["hits"]) =>
  ({
    hits,
    facets: null,
    nextCursor: null,
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    pageReach: SEARCH_PAGE_REACH.REACHED,
    total: { type: "exact", count: hits.length },
    relaxedHitCount: 0,
    queryUsed: "fixture query",
    warnings: [],
  }) satisfies DecisionSearchResponse;

const statutePage = (items: StatutesResponse["items"]) =>
  ({
    items,
    limit: 25,
    nextCursor: null,
  }) satisfies StatutesResponse;

const installResponses = ({
  decisions = [],
  statutes = [],
}: {
  decisions?: DecisionSearchResponse["hits"];
  statutes?: StatutesResponse["items"];
} = {}) => {
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const address = input instanceof Request ? input.url : input;
      const url = new URL(address, "http://localhost:3000");
      requests.push(url);
      if (url.pathname.endsWith("/v1/case/decisions/search")) {
        return Response.json(decisionPage(decisions));
      }
      if (url.pathname.endsWith("/v1/law/statutes")) {
        return Response.json(statutePage(statutes));
      }
      return Response.json(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
};

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("shared legal citation lookup", () => {
  test("the shared predicate selects identifiers and acts, but leaves keywords alone", () => {
    expect(
      isLegalCitationSearch({ country: "CZE", query: docketWithSheet }),
    ).toBe(true);
    expect(isLegalCitationSearch({ country: "CZE", query: ecli })).toBe(true);
    expect(
      isLegalCitationSearch({ country: "CZE", query: "89/2012 Sb." }),
    ).toBe(true);
    expect(
      isLegalCitationSearch({ country: "CZE", query: "nájemní smlouva" }),
    ).toBe(false);
  });

  test("a sheet docket resolves to the same decision as the legal database opener", async () => {
    const queryClient = client();
    const requests = installResponses({ decisions: [decision] });

    const shared = await readLegalCitationSearch({
      country: "CZE",
      query: docketWithSheet,
      queryClient,
    });
    const ownerResolution = await readDecisionMatch({
      excerpt: "short",
      queryClient,
      search: { country: "CZE", q: docketWithSheet },
    });
    const navigations: unknown[] = [];
    const opened = await openDecisionMatch({
      excerpt: "short",
      navigate: async (options) => {
        navigations.push(options);
      },
      queryClient,
      search: { country: "CZE", q: docketWithSheet },
      uiLocale: "cs",
    });

    expect(shared).toMatchObject({
      type: "decisions",
      resolution: { status: "unique" },
    });
    expect(ownerResolution).toMatchObject({ status: "unique" });
    if (shared.type !== "decisions" || shared.resolution.status !== "unique") {
      throw new TypeError("The sheet docket should resolve to one decision");
    }
    if (ownerResolution?.status !== "unique") {
      throw new TypeError(
        "The legal database lookup should resolve one decision",
      );
    }
    expect(shared.items.at(0)?.id).toBe(ownerResolution.decision.id);
    expect(opened).toBe(true);
    const commandHit = citationCommandHits(shared).at(0);
    if (commandHit === undefined) {
      throw new TypeError("The citation should produce a global search option");
    }
    expect(navigations).toEqual([citationCommandRoute(commandHit, "cs")]);
    expect(requests).toHaveLength(1);
  });

  test("an ECLI resolves to the same decision as the legal database opener", async () => {
    const queryClient = client();
    const requests = installResponses({ decisions: [ecliDecision] });
    const shared = await readLegalCitationSearch({
      country: "CZE",
      query: ecli,
      queryClient,
    });
    const navigations: unknown[] = [];
    const opened = await openDecisionMatch({
      excerpt: "short",
      navigate: async (options) => {
        navigations.push(options);
      },
      queryClient,
      search: { country: "CZE", q: ecli },
      uiLocale: "cs",
    });

    expect(shared).toMatchObject({
      type: "decisions",
      resolution: { status: "unique" },
    });
    if (shared.type !== "decisions") {
      throw new TypeError("The ECLI should return a decision");
    }
    expect(shared.items.at(0)?.id).toBe(ecliDecision.decisionId);
    expect(opened).toBe(true);
    const commandHit = citationCommandHits(shared).at(0);
    if (commandHit === undefined) {
      throw new TypeError("The citation should produce a global search option");
    }
    expect(navigations).toEqual([citationCommandRoute(commandHit, "cs")]);
    expect(requests).toHaveLength(1);
  });

  test("an act number resolves to the same work as the legal database opener", async () => {
    const queryClient = client();
    const requests = installResponses({ statutes: [statute] });
    const shared = await readLegalCitationSearch({
      country: "cze",
      query: "89/2012 Sb.",
      queryClient,
    });
    const navigations: unknown[] = [];
    const opened = await openStatuteMatch({
      country: "cze",
      navigate: async (options) => {
        navigations.push(options);
      },
      q: "89/2012 Sb.",
      queryClient,
    });

    expect(shared).toMatchObject({ type: "statutes", intent: { type: "act" } });
    if (shared.type !== "statutes") {
      throw new TypeError("The act number should return a statute");
    }
    expect(shared.items.at(0)?.id).toBe(statute.id);
    expect(opened).toBe(true);
    const commandHit = citationCommandHits(shared).at(0);
    if (commandHit === undefined) {
      throw new TypeError("The citation should produce a global search option");
    }
    expect(navigations).toEqual([citationCommandRoute(commandHit, "cs")]);
    expect(requests).toHaveLength(1);
  });

  test("plain keywords return no citation and make no requests", async () => {
    const queryClient = client();
    const requests = installResponses();
    const result = await readLegalCitationSearch({
      country: "CZE",
      query: "nájemní smlouva výpověď",
      queryClient,
    });

    expect(result).toEqual({ type: "none" });
    expect(requests).toEqual([]);
  });

  test("a docket shared by two decisions returns candidates without choosing one", async () => {
    const second = {
      ...decision,
      decisionId: "00000000-0000-4000-8000-000000000051",
      slug: "22-as-40-2025-50",
      identifiers: [{ type: "case-number", value: "22 As 40/2025 - 50" }],
    } satisfies DecisionSearchResponse["hits"][number];
    const queryClient = client();
    installResponses({ decisions: [decision, second] });

    const result = await readLegalCitationSearch({
      country: "CZE",
      query: docket,
      queryClient,
    });

    expect(result).toMatchObject({
      type: "decisions",
      resolution: { status: "ambiguous", reason: "several" },
      items: [{ id: decision.decisionId }, { id: second.decisionId }],
    });
  });
});
