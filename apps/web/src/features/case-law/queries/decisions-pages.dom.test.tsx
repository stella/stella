import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  SEARCH_PAGE_END,
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
} from "@stll/api-contract/search";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { DecisionListFilters } from "./decisions";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const originalFetch = globalThis.fetch;
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { decisionsPageOptions, usePrefetchedDecisionPage } =
  await import("./decisions");
const { shouldRetryAPIRequest } = await import("@/lib/errors/api");

const PAGE_SIZE = 25;
const RESULTS = 1000;
const FILTERS = {
  country: "CZ",
  excerpt: "short",
  search: "náhrada škody",
} as const satisfies DecisionListFilters;

/** A stable decision id per rank, shaped like the ids the API returns. */
const decisionIdAt = (rank: number) =>
  `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
const caseNumberAt = (rank: number) => `25 Cdo ${String(rank)}/2024`;

type SearchRequest = { offset: number | undefined; limit: unknown };

/**
 * The search endpoint over a fixed ranking: it answers whatever slice the
 * request's offset and limit name, and records every request it was sent.
 */
const installSearch = () => {
  const requests: SearchRequest[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      let address: string;
      if (typeof input === "string") {
        address = input;
      } else if (input instanceof URL) {
        address = input.href;
      } else {
        address = input.url;
      }
      const url = new URL(address, "http://localhost:3000");
      if (!url.pathname.endsWith("/v1/case/decisions/search")) {
        return Response.json(null, { status: 404 });
      }
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const offset =
        typeof body === "object" &&
        body !== null &&
        "offset" in body &&
        typeof body.offset === "number"
          ? body.offset
          : undefined;
      const limit =
        typeof body === "object" && body !== null && "limit" in body
          ? body.limit
          : undefined;
      requests.push({ offset, limit });
      const start = offset ?? 0;
      const ranks = Array.from(
        { length: Math.max(0, Math.min(PAGE_SIZE, RESULTS - start)) },
        (_, index) => start + index,
      );
      return Response.json({
        paginationOutcome: SEARCH_PAGINATION_COMPLETE,
        pageReach: SEARCH_PAGE_REACH.REACHED,
        hits: ranks.map((rank) => ({
          decisionId: decisionIdAt(rank),
          caseNumber: caseNumberAt(rank),
          court: "Nejvyšší soud",
          country: "CZ",
          language: "cs",
          languageAlternates: [],
          identifiers: [],
          citationCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
        facets: null,
        nextCursor: start + PAGE_SIZE < RESULTS ? "next" : null,
        total: { type: "estimate", count: RESULTS },
        queryUsed: FILTERS.search,
        warnings: [],
      });
    },
    { preconnect: () => undefined },
  );
  return requests;
};

const clients: InstanceType<typeof QueryClient>[] = [];
const makeClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryAPIRequest,
        retryDelay: 0,
        gcTime: Infinity,
      },
    },
  });
  clients.push(client);
  return client;
};

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/** One page on screen, warming the page after it the way the results route does. */
const ResultsPage = ({ page }: { page: number }) => {
  const { data } = useQuery(
    decisionsPageOptions({ filters: FILTERS, page, pageSize: PAGE_SIZE }),
  );
  usePrefetchedDecisionPage({
    filters: FILTERS,
    page: data?.end === SEARCH_PAGE_END.MORE ? page + 1 : null,
    pageSize: PAGE_SIZE,
  });
  return (
    <ol data-testid="rows">
      {data?.decisions.map((decision) => (
        <li key={decision.id}>{decision.id}</li>
      ))}
    </ol>
  );
};

const firstRow = (view: ReturnType<typeof render>) =>
  view.getByTestId("rows").firstElementChild?.textContent;

describe("a page of case-law results", () => {
  test("a jump fetches that page directly, in one request", async () => {
    const requests = installSearch();
    const client = makeClient();

    const page = await client.query(
      decisionsPageOptions({ filters: FILTERS, page: 7, pageSize: PAGE_SIZE }),
    );

    expect(requests).toEqual([{ offset: 6 * PAGE_SIZE, limit: PAGE_SIZE }]);
    expect(page.decisions.map((decision) => decision.caseNumber)).toEqual(
      Array.from({ length: PAGE_SIZE }, (_, index) =>
        caseNumberAt(6 * PAGE_SIZE + index),
      ),
    );
  });

  test("the first page asks for no offset", async () => {
    const requests = installSearch();
    const client = makeClient();

    await client.query(
      decisionsPageOptions({ filters: FILTERS, page: 1, pageSize: PAGE_SIZE }),
    );

    expect(requests).toEqual([{ offset: undefined, limit: PAGE_SIZE }]);
  });

  test("the next page is fetched once this one is shown, and Next draws it from the cache", async () => {
    const requests = installSearch();
    const client = makeClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ResultsPage page={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(firstRow(view)).toBe(decisionIdAt(0));
    });
    const secondPage = decisionsPageOptions({
      filters: FILTERS,
      page: 2,
      pageSize: PAGE_SIZE,
    });
    await waitFor(() => {
      expect(client.getQueryState(secondPage.queryKey)?.status).toBe("success");
    });
    expect(requests).toEqual([
      { offset: undefined, limit: PAGE_SIZE },
      { offset: PAGE_SIZE, limit: PAGE_SIZE },
    ]);

    view.rerender(
      <QueryClientProvider client={client}>
        <ResultsPage page={2} />
      </QueryClientProvider>,
    );

    // Drawn in the same render that asked for it: no request, no wait.
    expect(firstRow(view)).toBe(decisionIdAt(PAGE_SIZE));
    expect(
      requests.filter((request) => request.offset === PAGE_SIZE),
    ).toHaveLength(1);
    // And the page after that is warmed in turn.
    await waitFor(() => {
      expect(requests.at(-1)).toEqual({
        offset: 2 * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
    });
  });
});
