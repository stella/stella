import { panic } from "better-result";
import { expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import {
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { api } from "@/lib/api";
import { PUBLIC_LAW_READ_TIMEOUT_MS } from "@/lib/public-law-api";
import type { PublicLawData } from "@/lib/public-law-api";

import type { FixtureRuntime } from "./route-shell-provider-fixture";

type SearchResponse = PublicLawData<typeof api.case.decisions.search.post>;
const query = "odpovědnost za škodu";
const searchBody = v.object({
  query: v.string(),
  offset: v.optional(v.number(), 0),
});
const hit = {
  decisionId: "00000000-0000-4000-8000-000000000011",
  caseNumber: "SYN 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  slug: "fixture-decision",
  ecli: null,
  identifiers: [
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "SYN 1/2026" },
  ],
  court: "Fixture court",
  courtAbbreviation: null,
  courtTier: "other",
  country: "SVK",
  language: "sk",
  languageAlternates: [],
  decisionDate: "2026-01-01",
  decisionType: null,
  sourceUrl: null,
  headnote: { type: "absent", reason: "not_published" },
  keywords: null,
  textWithheldReason: null,
  citationAuthority: 0,
  matchingPassages: 1,
  headline: "Fixture <mark>odpovědnost</mark> za <mark>škodu</mark>",
  match: "all_terms",
  anchorId: null,
  citationCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies SearchResponse["hits"][number];

const response = (offset: number) =>
  ({
    hits: Array.from({ length: 50 }, (_, index) => ({
      ...hit,
      decisionId: `00000000-0000-4000-8000-${String(offset + index + 1).padStart(12, "0")}`,
      caseNumber: `SYN ${offset + index + 1}/2026`,
    })),
    facets:
      offset > 0
        ? null
        : {
            court: [],
            courtYear: null,
            year: [],
            decisionType: [],
            source: [],
            language: [],
          },
    total:
      offset > 0 ? SEARCH_TOTAL_NOT_COUNTED : { type: "estimate", count: 366 },
    relaxedHitCount: 0,
    nextCursor: "fixture-next-cursor",
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    pageReach: SEARCH_PAGE_REACH.REACHED,
    queryUsed: "odpovědnost škodu",
    warnings: [
      {
        code: "function_words_optional",
        message: "Fixture warning",
        hint: "Fixture hint",
      },
    ],
  }) satisfies SearchResponse;

export const declareCaseSearchNavigationCases = (fixture: FixtureRuntime) => {
  const audienceCases = [
    {
      name: "anonymous",
      audience: "anonymous",
      expansion: { alternatives: [], outcome: "none" },
    },
    {
      name: "member",
      audience: "member",
      expansion: { alternatives: [], outcome: "none" },
    },
    {
      name: "expanded",
      audience: "member",
      expansion: {
        alternatives: [{ term: "odpovědnost", alternatives: ["zodpovednosť"] }],
        outcome: "expanded",
      },
    },
  ] as const satisfies readonly {
    name: string;
    audience: FixtureRuntime["state"]["audience"];
    expansion: NonNullable<
      Awaited<ReturnType<typeof api.case.decisions.search.expand.post>>["data"]
    >;
  }[];
  for (const scenario of audienceCases) {
    test(`case search keeps the content and pager focus after stepping to page two as ${scenario.name}`, async () => {
      const searched: v.InferOutput<typeof searchBody>[] = [];
      fixture.state.audience = scenario.audience;
      fixture.state.response = async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/case/decisions/search/expand") {
          return Response.json(scenario.expansion);
        }
        if (pathname === "/v1/case/research/answers/lookup") {
          return Response.json({ items: [] });
        }
        if (pathname !== "/v1/case/decisions/search") {
          return undefined;
        }
        const body = v.parse(searchBody, await request.json());
        searched.push(body);
        return Response.json(response(body.offset));
      };
      const runtime = await mountCaseSearch(fixture);
      try {
        await typeQuery(fixture, query);
        await fixture.waitFor(() => {
          expect(runtime.router.state.location.search.q).toBe(query);
          expect(document.body.textContent).toContain("SYN 1/2026");
        });
        const next = document.querySelector('a[aria-label="Next"]');
        if (!(next instanceof HTMLAnchorElement)) {
          panic("The case-law pager must offer the next page");
        }
        next.focus();
        expect(document.activeElement).toBe(next);
        const { fireEvent } = await import("@testing-library/react");
        fixture.act(() => {
          fireEvent.click(next);
        });
        await fixture.waitFor(() => {
          expect(
            runtime.router.state.matches.find(
              (match) => match.routeId === "/law/cases/",
            )?.search.page,
          ).toBe(2);
          expect(document.body.textContent).toContain("SYN 51/2026");
          expect(searchInput().value).toBe(query);
        });
        expect(next.isConnected).toBe(true);
        expect(document.activeElement).toBe(next);
        expect(searched).toContainEqual({ query, offset: 0 });
        expect(searched).toContainEqual({ query, offset: 50 });
        expect(runtime.caughtErrors).toEqual([]);
      } finally {
        await unmountCaseSearch(fixture, runtime);
      }
    });
  }

  for (const { name, selector, label, expected } of [
    { name: "dismiss", selector: "button", label: "Dismiss", expected: { country: "cze" } },
    { name: "correct", selector: "a", label: "Show Ústavný súd SR in Slovakia", expected: { country: "svk", court: "Ústavný súd SR" } },
  ]) {
    test(`case search renders the removed-filter notice and retains presentation search state on ${name}`, async () => {
      fixture.state.audience = "anonymous";
      fixture.state.response = async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/case/decisions/filter-validation") {
          return Response.json({ filters: { court: "Ústavný súd SR" }, removed: [] });
        }
        if (url.pathname === "/v1/case/decisions/search") {
          const body = v.parse(searchBody, await request.json());
          return Response.json(response(body.offset));
        }
        return undefined;
      };
      const runtime = await mountCaseSearch(fixture);
      try {
        await fixture.act(async () => {
          await runtime.router.navigate({
            to: "/law/cases",
            search: {
              country: "cze",
              q: query,
              questions: ["question-fixture"],
              rewrite: "off",
              rewrittenFrom: "original query",
              filterNotice: [{ field: "court", value: "Ústavný súd SR", countries: ["SVK"] }],
            },
          });
        });
        await fixture.waitFor(() => {
          expect(document.body.textContent).toContain("SYN 1/2026");
          expect([...document.querySelectorAll('[role="status"]')].some((status) => status.textContent.includes("Ústavný súd SR"))).toBe(true);
        });
        const target = [...document.querySelectorAll(selector)].find(
          (element) => element.textContent === label,
        );
        if (target === undefined) {
          panic("The mounted search must offer the notice action");
        }
        const { fireEvent } = await import("@testing-library/react");
        await fixture.act(async () => { fireEvent.click(target); });
        await fixture.waitFor(() => {
          expect(runtime.router.state.location.search).toMatchObject({
            ...expected,
            q: query,
            questions: ["question-fixture"],
            rewrite: "off",
            rewrittenFrom: "original query",
          });
          expect(runtime.router.state.location.search.filterNotice).toBeUndefined();
        });
        expect(runtime.caughtErrors).toEqual([]);
      } finally {
        await unmountCaseSearch(fixture, runtime);
      }
    });
  }

  test("case search correction redirects a foreign court without losing presentation state or valid filters", async () => {
    const retained = {
      country: "cze",
      q: query,
      questions: ["question-fixture"],
      rewrite: "off",
      rewrittenFrom: "original query",
      from: "2026-01-01",
      to: "2026-12-31",
      lang: "cs",
      type: "judgment",
      sourceId: "00000000-0000-4000-8000-000000000012",
    } as const;
    const removed = [
      { field: "court", value: "Ústavný súd SR", countries: ["SVK"] },
    ];
    const validatedCourts: (string | null)[] = [];
    fixture.state.audience = "anonymous";
    fixture.state.response = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/case/decisions/filter-validation") {
        const court = url.searchParams.get("court");
        validatedCourts.push(court);
        return Response.json({
          filters: {
            lang: retained.lang,
            type: retained.type,
            sourceId: retained.sourceId,
          },
          removed: court === null ? [] : removed,
        });
      }
      if (url.pathname === "/v1/case/decisions/search") {
        const body = v.parse(searchBody, await request.json());
        return Response.json(response(body.offset));
      }
      return undefined;
    };
    const runtime = await mountCaseSearch(fixture);
    try {
      await fixture.act(async () => {
        await runtime.router.navigate({
          to: "/law/cases",
          search: { ...retained, questions: [...retained.questions], court: "Ústavný súd SR", page: 2 },
        });
      });
      await fixture.waitFor(() => {
        expect(validatedCourts).toContain("Ústavný súd SR");
        expect(runtime.router.state.location.search).toMatchObject({
          ...retained,
          filterNotice: removed,
        });
        expect(runtime.router.state.location.search.court).toBeUndefined();
        expect(runtime.router.state.location.search.page).toBeUndefined();
        expect(searchInput().value).toBe(query);
        expect(document.body.textContent).toContain("SYN 1/2026");
        expect([...document.querySelectorAll('[role="status"]')].some((status) => status.textContent.includes("Ústavný súd SR"))).toBe(true);
      });
      expect(runtime.caughtErrors).toEqual([]);
    } finally {
      await unmountCaseSearch(fixture, runtime);
    }
  });

  for (const failure of [
    { name: "429", status: 429, code: "TOO_MANY_REQUESTS" },
    { name: "503", status: 503, code: "INTERNAL_SERVER_ERROR" },
    { name: "timeout", status: 503, code: "57014" },
  ]) {
    test(`case search keeps the page and selected filters usable after filter validation ${failure.name}`, async () => {
      let validationRequests = 0;
      fixture.state.audience = "anonymous";
      fixture.state.response = async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/case/decisions/filter-validation") {
          validationRequests += 1;
          return Response.json({ code: failure.code, message: "Validation unavailable" }, { status: failure.status });
        }
        if (pathname === "/v1/case/decisions/search") {
          const body = v.parse(searchBody, await request.json());
          return Response.json(response(body.offset));
        }
        return undefined;
      };
      const runtime = await mountCaseSearch(fixture);
      try {
        await fixture.act(async () => {
          await runtime.router.navigate({ to: "/law/cases", search: { country: "svk", court: "Ústavný súd SR", q: query } });
        });
        await fixture.waitFor(() => {
          expect(validationRequests).toBeGreaterThan(0);
          expect(document.body.textContent).toContain("SYN 1/2026");
          expect(document.body.textContent).toContain("Filters");
          expect(searchInput().value).toBe(query);
          expect(runtime.router.state.location.search.court).toBe("Ústavný súd SR");
          expect(runtime.router.state.location.search.filterNotice).toBeUndefined();
        });
        expect(runtime.caughtErrors).toEqual([]);
      } finally {
        await unmountCaseSearch(fixture, runtime);
      }
    });
  }

  test("case search uses the same requests for ten times as many matches at a fixed page size", async () => {
    const measurements: { searches: number; facets: number }[] = [];
    for (const count of [366, 3660]) {
      fixture.state.audience = "anonymous";
      fixture.state.response = async (request) => {
        if (new URL(request.url).pathname !== "/v1/case/decisions/search") {
          return undefined;
        }
        const body = v.parse(searchBody, await request.json());
        return Response.json({
          ...response(body.offset),
          ...(body.offset === 0 && { total: { type: "estimate", count } }),
        } satisfies SearchResponse);
      };
      const requestStart = fixture.requests.length;
      const runtime = await mountCaseSearch(fixture);
      try {
        await typeQuery(fixture, query);
        await fixture.waitFor(() =>
          expect(document.body.textContent).toContain("SYN 1/2026"),
        );
        await fixture.act(async () => {
          await runtime.router.navigate({
            to: "/law/cases",
            search: { country: "svk", q: query, page: 2 },
          });
        });
        await fixture.waitFor(() => {
          expect(document.body.textContent).toContain("SYN 51/2026");
          expect(runtime.queryClient.isFetching()).toBe(0);
        });
        const requests = fixture.requests.slice(requestStart);
        measurements.push({
          searches: requests.filter(
            (path) => path === "/v1/case/decisions/search",
          ).length,
          facets: requests.filter(
            (path) => path === "/v1/case/decisions/facets",
          ).length,
        });
      } finally {
        await unmountCaseSearch(fixture, runtime);
      }
    }
    expect(measurements).toEqual([
      { searches: 3, facets: 1 },
      { searches: 3, facets: 1 },
    ]);
  });

  test("case search keeps the latest navigation when earlier searches and facets finish late", async () => {
    const oldSearch = Promise.withResolvers<undefined>();
    const currentSearch = Promise.withResolvers<undefined>();
    const facets = Promise.withResolvers<undefined>();
    const searched: string[] = [];
    const fragment = "odpovědnost";
    fixture.state.audience = "member";
    fixture.state.response = async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/case/decisions/facets") {
        await facets.promise;
        return Response.json({ country: [], court: [], year: [] });
      }
      if (pathname === "/v1/case/decisions/search/expand") {
        await currentSearch.promise;
        return Response.json({ alternatives: [], outcome: "none" });
      }
      if (pathname === "/v1/case/research/answers/lookup") {
        return Response.json({ items: [] });
      }
      if (pathname !== "/v1/case/decisions/search") {
        return undefined;
      }
      const body = v.parse(searchBody, await request.json());
      searched.push(body.query);
      if (body.query === fragment) {
        await oldSearch.promise;
      } else if (body.query === query) {
        await currentSearch.promise;
      }
      return Response.json(response(body.offset));
    };
    const runtime = await mountCaseSearch(fixture);
    try {
      await typeQuery(fixture, fragment);
      await fixture.waitFor(() => expect(searched).toContain(fragment));
      await typeQuery(fixture, query);
      await fixture.waitFor(() => expect(searched).toContain(query));
      expect(searchInput().value).toBe(query);
      const navigation = runtime.router.navigate({
        to: "/law/cases",
        search: { country: "svk", q: query, page: 2 },
      });
      await fixture.act(async () => {
        currentSearch.resolve(undefined);
        await navigation;
      });
      await fixture.waitFor(() =>
        expect(document.body.textContent).toContain("SYN 51/2026"),
      );
      fixture.act(() => {
        oldSearch.resolve(undefined);
        facets.resolve(undefined);
      });
      await fixture.waitFor(() => {
        expect(searchInput().value).toBe(query);
        expect(
          runtime.router.state.matches.find(
            (match) => match.routeId === "/law/cases/",
          )?.search.page,
        ).toBe(2);
        expect(document.body.textContent).toContain("SYN 51/2026");
      });
      expect(runtime.caughtErrors).toEqual([]);
    } finally {
      oldSearch.resolve(undefined);
      currentSearch.resolve(undefined);
      facets.resolve(undefined);
      await unmountCaseSearch(fixture, runtime);
    }
  });

  test("case search finishes page navigation when delayed expansion replaces its unexpanded prefetch", async () => {
    const expansion = Promise.withResolvers<undefined>();
    const pendingPage = Promise.withResolvers<Response>();
    let pageStarted = false;
    let pageCancelled = false;
    let expandedRequestStarted = false;
    fixture.state.audience = "member";
    fixture.state.response = async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/case/decisions/search/expand") {
        await expansion.promise;
        return Response.json({
          alternatives: [
            { term: "odpovědnost", alternatives: ["zodpovednosť"] },
          ],
          outcome: "expanded",
        } satisfies NonNullable<
          Awaited<
            ReturnType<typeof api.case.decisions.search.expand.post>
          >["data"]
        >);
      }
      if (pathname === "/v1/case/research/answers/lookup") {
        return Response.json({ items: [] });
      }
      if (pathname !== "/v1/case/decisions/search") {
        return undefined;
      }
      const body = v.parse(
        v.object({
          ...searchBody.entries,
          alternatives: v.optional(v.unknown()),
        }),
        await request.json(),
      );
      if (body.alternatives !== undefined) {
        expandedRequestStarted = true;
      }
      if (
        body.offset === 50 &&
        body.alternatives === undefined &&
        !pageStarted
      ) {
        pageStarted = true;
        if (request.signal.aborted) {
          pageCancelled = true;
          throw abortFailure(request.signal);
        }
        const abortPage = () => {
          pageCancelled = true;
          pendingPage.reject(abortFailure(request.signal));
        };
        request.signal.addEventListener("abort", abortPage, { once: true });
        try {
          return await pendingPage.promise;
        } finally {
          request.signal.removeEventListener("abort", abortPage);
        }
      }
      return Response.json(response(body.offset));
    };
    const runtime = await mountCaseSearch(fixture);
    try {
      await typeQuery(fixture, query);
      await fixture.waitFor(() => {
        expect(pageStarted).toBe(true);
        expect(document.body.textContent).toContain("SYN 1/2026");
      });
      const navigation = runtime.router.navigate({
        to: "/law/cases",
        search: { country: "svk", q: query, page: 2 },
      });
      await fixture.waitFor(() =>
        expect(runtime.router.state.isLoading).toBe(true),
      );
      fixture.act(() => expansion.resolve(undefined));
      await fixture.waitFor(() => expect(expandedRequestStarted).toBe(true));
      await fixture.act(async () => {
        pendingPage.resolve(Response.json(response(50)));
        await navigation;
      });
      await fixture.waitFor(() => {
        expect(
          runtime.router.state.matches.find(
            (match) => match.routeId === "/law/cases/",
          )?.status,
        ).toBe("success");
        expect(document.body.textContent).toContain("SYN 51/2026");
      });
      expect(pageCancelled).toBe(false);
      expect(runtime.caughtErrors).toEqual([]);
    } finally {
      expansion.resolve(undefined);
      pendingPage.resolve(Response.json(response(50)));
      await unmountCaseSearch(fixture, runtime);
    }
  });

  test("case search corrects a client navigation past the results to the last page", async () => {
    fixture.state.audience = "anonymous";
    fixture.state.response = async (request) => {
      if (new URL(request.url).pathname !== "/v1/case/decisions/search") {
        return undefined;
      }
      const body = v.parse(searchBody, await request.json());
      return Response.json({
        ...response(body.offset),
        hits: body.offset > 0 ? [] : response(0).hits,
        total: { type: "exact", count: 50 },
        nextCursor: null,
      } satisfies SearchResponse);
    };
    const runtime = await mountCaseSearch(fixture);
    try {
      await typeQuery(fixture, query);
      await fixture.waitFor(() =>
        expect(document.body.textContent).toContain("SYN 1/2026"),
      );
      await fixture.act(async () => {
        await runtime.router.navigate({
          to: "/law/cases",
          search: { country: "svk", q: query, page: 2 },
        });
      });
      await fixture.waitFor(() => {
        expect(
          runtime.router.state.matches.find(
            (match) => match.routeId === "/law/cases/",
          )?.search.page,
        ).toBeUndefined();
        expect(searchInput().value).toBe(query);
        expect(document.body.textContent).toContain("SYN 1/2026");
      });
      expect(runtime.caughtErrors).toEqual([]);
    } finally {
      await unmountCaseSearch(fixture, runtime);
    }
  });

  test("case search route rejects an invalid search visibly and recovers on submit", async () => {
    const { fireEvent } = await import("@testing-library/react");
    fixture.state.audience = "anonymous";
    fixture.state.response = async (request) => {
      if (new URL(request.url).pathname !== "/v1/case/decisions/search") {
        return undefined;
      }
      const body = v.parse(searchBody, await request.json());
      if (body.query === query) {
        return Response.json({ message: "Invalid search" }, { status: 400 });
      }
      return Response.json(response(body.offset));
    };
    const runtime = await mountCaseSearch(fixture);
    try {
      await fixture.act(async () => {
        await runtime.router.navigate({
          to: "/law/cases",
          search: { country: "svk", q: query, page: 2 },
        });
      });
      await fixture.waitFor(() => {
        expect(searchInput().value).toBe(query);
        expect(document.querySelector('[role="alert"]')).not.toBeNull();
        expect(document.body.textContent).toContain("Filters");
        expect(
          [...document.querySelectorAll("button")].some((button) =>
            button.textContent.includes("Retry"),
          ),
        ).toBe(false);
      });
      await typeQuery(fixture, "náhrada škody");
      const form = searchInput().closest("form");
      if (form === null) {
        panic("The search must be submittable");
      }
      fixture.act(() => {
        fireEvent.submit(form);
      });
      await fixture.waitFor(() =>
        expect(document.body.textContent).toContain("SYN 1/2026"),
      );
    } finally {
      await unmountCaseSearch(fixture, runtime);
    }
  });

  test("case search bounds a hung background fetch and keeps the search usable", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() =>
      nativeTimeout(20),
    );
    fixture.state.audience = "anonymous";
    fixture.state.response = async (request) => {
      if (new URL(request.url).pathname !== "/v1/case/decisions/search") {
        return undefined;
      }
      const body = v.parse(searchBody, await request.json());
      if (body.query !== query) {
        return Response.json(response(body.offset));
      }
      if (request.signal.aborted) {
        throw abortFailure(request.signal);
      }
      return await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(abortFailure(request.signal)),
          { once: true },
        );
      });
    };
    const runtime = await mountCaseSearch(fixture);
    try {
      await typeQuery(fixture, query);
      await fixture.waitFor(() => {
        expect(searchInput().value).toBe(query);
        expect(document.body.textContent).toContain(
          "Search is temporarily unavailable",
        );
      });
      expect(timeout).toHaveBeenCalledWith(PUBLIC_LAW_READ_TIMEOUT_MS);
      await typeQuery(fixture, "náhrada škody");
      await fixture.waitFor(() =>
        expect(document.body.textContent).toContain("SYN 1/2026"),
      );
      expect(runtime.caughtErrors).toEqual([]);
    } finally {
      timeout.mockRestore();
      await unmountCaseSearch(fixture, runtime);
    }
  });

  const failureCases = [
    { type: "api", name: "500", status: 500, code: "INTERNAL_SERVER_ERROR" },
    { type: "api", name: "503", status: 503, code: "INTERNAL_SERVER_ERROR" },
    { type: "api", name: "timeout", status: 503, code: "57014" },
    { type: "row", name: "row" },
  ] as const;
  for (const failure of failureCases) {
    test(`case search keeps the search and filters usable after a ${failure.name} failure during navigation`, async () => {
      fixture.state.audience = "anonymous";
      fixture.state.response = async (request) => {
        if (new URL(request.url).pathname !== "/v1/case/decisions/search") {
          return undefined;
        }
        const body = v.parse(searchBody, await request.json());
        if (body.query !== query) {
          return Response.json(response(body.offset));
        }
        if (failure.type === "row") {
          const page = response(body.offset);
          // Malformed external data reaches the actual summary cell's renderer.
          return Response.json({
            ...page,
            hits: page.hits.map((item) => ({
              ...item,
              headnote: { type: "unknown" },
            })),
          });
        }
        return Response.json(
          {
            code: failure.code,
            message:
              failure.code === "57014"
                ? "canceling statement due to statement timeout"
                : "Search unavailable",
          },
          { status: failure.status },
        );
      };
      const runtime = await mountCaseSearch(fixture);
      try {
        await typeQuery(fixture, query);
        await fixture.waitFor(() => {
          expect(searchInput().value).toBe(query);
          expect(document.body.textContent).toContain(
            failure.type === "row"
              ? "Something went wrong"
              : "Search is temporarily unavailable",
          );
          expect(
            [...document.querySelectorAll("button")].some((button) =>
              button.textContent.includes("Filters"),
            ),
          ).toBe(true);
        });
        // Changing the query works even while the previous results failed.
        await typeQuery(fixture, "náhrada škody");
        await fixture.waitFor(() =>
          expect(document.body.textContent).toContain("SYN 1/2026"),
        );
        if (failure.type === "row") {
          expect(runtime.caughtErrors.length).toBeGreaterThan(0);
          expect(
            runtime.caughtErrors.every((error) =>
              error.message.includes("Unhandled decision headnote"),
            ),
          ).toBe(true);
        } else {
          expect(runtime.caughtErrors).toEqual([]);
        }
      } finally {
        await unmountCaseSearch(fixture, runtime);
      }
    });
  }
};

async function mountCaseSearch(fixture: FixtureRuntime) {
  const runtime = fixture.createFixtureRouter("/law/cases?country=svk");
  runtime.queryClient.setDefaultOptions({ queries: { retryDelay: 0 } });
  await fixture.initializeI18n();
  await fixture.act(async () => {
    await runtime.router.load();
    fixture.render(<fixture.RouterProvider router={runtime.router} />, {
      container: document,
      onCaughtError: (error) => {
        runtime.caughtErrors.push(
          error instanceof Error ? error : panic(String(error)),
        );
      },
    });
  });
  await fixture.waitFor(() => expect(searchInput()).not.toBeNull());
  return runtime;
}

function searchInput() {
  const input = document.querySelector('input[type="search"]');
  if (!(input instanceof HTMLInputElement)) {
    return panic("The case-law search input must exist");
  }
  return input;
}

async function typeQuery(fixture: FixtureRuntime, value: string) {
  const { fireEvent } = await import("@testing-library/react");
  fixture.act(() => {
    fireEvent.change(searchInput(), { target: { value } });
  });
}

async function unmountCaseSearch(
  fixture: FixtureRuntime,
  runtime: Awaited<ReturnType<typeof mountCaseSearch>>,
) {
  await fixture.act(async () => {
    await runtime.queryClient.cancelQueries();
    runtime.queryClient.clear();
    fixture.cleanup();
  });
  delete fixture.state.response;
}

function abortFailure(signal: AbortSignal) {
  if (!(signal.reason instanceof Error)) {
    return panic("The deadline must abort with an Error");
  }
  return signal.reason;
}
