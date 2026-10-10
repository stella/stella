import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { CaseLawBrowseFacets } from "./queries/decisions";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases/CZ" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { act } = await import("react");
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery, keepPreviousData } =
  await import("@tanstack/react-query");
const { prefetchDecisionFacetsAfterSearch, useDecisionBrowseFacets } =
  await import("./decision-filter-facets");
const { decisionFacetsOptions, decisionsPageOptions } =
  await import("./queries/decisions");
const { APIError, shouldRetryAPIRequest } = await import("@/lib/errors/api");

const facets = {
  country: [],
  court: [{ value: "supreme", label: "Supreme court", count: 3 }],
  year: [{ value: "2026", count: 3 }],
} satisfies CaseLawBrowseFacets;
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
const installTransport = (respond: () => Response | Promise<Response>) => {
  const requests: { url: URL; method: string }[] = [];
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
      requests.push({
        url,
        method:
          init?.method ?? (input instanceof Request ? input.method : "GET"),
      });
      return await respond();
    },
    { preconnect: () => undefined },
  );
  return requests;
};
const assertFacetRequest = (
  request: { url: URL; method: string } | undefined,
  country: string,
) => {
  expect(request?.url.pathname.endsWith("/v1/case/decisions/facets")).toBe(
    true,
  );
  expect(request?.url.searchParams.get("country")).toBe(country);
  expect(request?.method).toBe("GET");
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
  await GlobalRegistrator.unregister();
});

for (const fails of [false, true]) {
  test(`loader starts facets after search ${fails ? "failure" : "success"} without awaiting the facet response`, async () => {
    const search = Promise.withResolvers<object>();
    const response = Promise.withResolvers<Response>();
    const requests = installTransport(async () => await response.promise);
    const client = makeClient();
    const value = { decisionIds: ["decision"] };
    const failure = new APIError({
      status: 503,
      message: "Search unavailable",
    });
    const result = prefetchDecisionFacetsAfterSearch({
      country: "CZ",
      queryClient: client,
      search: search.promise,
    });
    const observed = result.then(
      (data) => ({ type: "success", data }),
      (error: unknown) => ({ type: "failure", error }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toHaveLength(0);
    if (!fails) {
      search.resolve(value);
    } else {
      search.reject(failure);
    }
    expect(await observed).toEqual(
      !fails
        ? { type: "success", data: value }
        : { type: "failure", error: failure },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    assertFacetRequest(requests.at(0), "CZ");
    expect(
      client.getQueryState(decisionFacetsOptions("CZ").queryKey)?.fetchStatus,
    ).toBe("fetching");
    response.resolve(Response.json(facets));
    await waitFor(() => {
      expect(
        client
          .getQueryCache()
          .find({ queryKey: decisionFacetsOptions("CZ").queryKey })?.state.data,
      ).toEqual(facets);
    });
  });
}

test("facet refusal cannot reject a successful route search", async () => {
  const requests = installTransport(() =>
    Response.json(
      { code: "forbidden", message: "Facet read refused" },
      { status: 403 },
    ),
  );
  const client = makeClient();
  const value = { decisionIds: ["decision"] };
  expect(
    await prefetchDecisionFacetsAfterSearch({
      country: "CZ",
      queryClient: client,
      search: Promise.resolve(value),
    }),
  ).toBe(value);
  await waitFor(() =>
    expect(
      client.getQueryState(decisionFacetsOptions("CZ").queryKey)?.status,
    ).toBe("error"),
  );
  expect(requests).toHaveLength(1);
});

type FacetPanelProps = {
  country: string;
  page: number;
  sort: string;
};
const FacetPanel = ({ country, page, sort }: FacetPanelProps) => {
  const result = useQuery({
    queryKey: ["fixture-search", country, page, sort],
    retry: false,
    placeholderData: keepPreviousData,
  });
  const facet = useDecisionBrowseFacets({
    country,
    searchFetched: result.isFetched,
    searchFetchStatus: result.fetchStatus,
  });
  return (
    <output
      data-testid="facets"
      data-search-status={result.status}
      data-status={facet.status}
      data-placeholder={facet.isPlaceholderData}
    >
      {JSON.stringify(facet.data ?? null)}
    </output>
  );
};
type MountFacetPanelOptions = FacetPanelProps & { search: Promise<object> };
const panelFor = (
  client: InstanceType<typeof QueryClient>,
  { search, ...props }: MountFacetPanelOptions,
) => {
  client.setQueryDefaults(
    ["fixture-search", props.country, props.page, props.sort],
    {
      queryFn: async () => await search,
    },
  );
  return (
    <QueryClientProvider client={client}>
      <FacetPanel {...props} />
    </QueryClientProvider>
  );
};
const mountPanel = (
  client: InstanceType<typeof QueryClient>,
  props: MountFacetPanelOptions,
) => render(panelFor(client, props));

for (const fails of [false, true]) {
  test(`panel waits for its search ${fails ? "failure" : "success"} before the facet GET`, async () => {
    const search = Promise.withResolvers<object>();
    const requests = installTransport(() => Response.json(facets));
    const client = makeClient();
    const view = mountPanel(client, {
      country: "CZ",
      page: 1,
      sort: "relevance",
      search: search.promise,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toHaveLength(0);
    await act(async () => {
      if (!fails) {
        search.resolve({ decisions: [] });
      } else {
        search.reject(
          new APIError({ status: 503, message: "Search unavailable" }),
        );
      }
    });
    await waitFor(() =>
      expect(view.getByTestId("facets").textContent).toBe(
        JSON.stringify(facets),
      ),
    );
    expect(view.getByTestId("facets").dataset["searchStatus"]).toBe(
      !fails ? "success" : "error",
    );
    expect(requests).toHaveLength(1);
    assertFacetRequest(requests.at(0), "CZ");
  });
}

test("warm facets survive panel mount and page/sort navigation without another facet key or GET", async () => {
  const requests = installTransport(() => Response.json(facets));
  const client = makeClient();
  const key = decisionFacetsOptions("CZ").queryKey;
  client.setQueryData(key, facets);
  const facetQuery = client
    .getQueryCache()
    .find({ queryKey: key, exact: true });
  const view = mountPanel(client, {
    country: "CZ",
    page: 1,
    sort: "relevance",
    search: Promise.resolve({ decisions: [] }),
  });
  for (const [page, sort] of [
    [2, "relevance"],
    [2, "newest"],
  ] satisfies [number, string][]) {
    await act(async () => {
      view.rerender(
        panelFor(client, {
          country: "CZ",
          page,
          sort,
          search: Promise.resolve({ decisions: [] }),
        }),
      );
    });
    await waitFor(() =>
      expect(view.getByTestId("facets").dataset["searchStatus"]).toBe(
        "success",
      ),
    );
    expect(view.getByTestId("facets").textContent).toBe(JSON.stringify(facets));
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBe(
      facetQuery,
    );
  }
  expect(
    client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey.includes("facets"))
      .map((query) => query.queryKey),
  ).toEqual([key]);
  expect(requests).toHaveLength(0);
});

test("a new country waits for its own search despite previous result placeholder data", async () => {
  const response = Promise.withResolvers<Response>();
  const requests = installTransport(async () => await response.promise);
  const client = makeClient();
  client.setQueryData(decisionFacetsOptions("CZ").queryKey, facets);
  client.setQueryData(["fixture-search", "CZ", 1, "relevance"], {
    decisions: [],
  });
  const view = mountPanel(client, {
    country: "CZ",
    page: 1,
    sort: "relevance",
    search: Promise.resolve({ decisions: [] }),
  });
  await act(async () => {
    await Promise.resolve();
  });
  const search = Promise.withResolvers<object>();
  view.rerender(
    panelFor(client, {
      country: "DE",
      page: 1,
      sort: "relevance",
      search: search.promise,
    }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(requests).toHaveLength(0);
  expect(view.getByTestId("facets").textContent).toBe(JSON.stringify(facets));
  await act(async () => {
    search.resolve({ decisions: [] });
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  assertFacetRequest(requests.at(0), "DE");
  expect(view.getByTestId("facets").dataset["placeholder"]).toBe("true");
  response.resolve(
    Response.json({
      country: [],
      court: [],
      year: [],
    } satisfies CaseLawBrowseFacets),
  );
  await waitFor(() =>
    expect(view.getByTestId("facets").textContent).toBe(
      JSON.stringify({ country: [], court: [], year: [] }),
    ),
  );
});

test("the shared 429 retry policy recovers the facet GET instead of caching rate limit as failure", async () => {
  let attempt = 0;
  const requests = installTransport(() => {
    attempt += 1;
    return attempt === 1
      ? Response.json(
          { code: "rate_limited", message: "Try again" },
          { status: 429 },
        )
      : Response.json(facets);
  });
  const client = makeClient();
  const view = mountPanel(client, {
    country: "CZ",
    page: 1,
    sort: "relevance",
    search: Promise.resolve({ decisions: [] }),
  });
  await waitFor(() =>
    expect(view.getByTestId("facets").textContent).toBe(JSON.stringify(facets)),
  );
  expect(requests).toHaveLength(2);
  expect(decisionFacetsOptions("CZ").retry).toBe(shouldRetryAPIRequest);
  expect(
    decisionsPageOptions({
      filters: { country: "CZ", search: "fixture query", excerpt: "short" },
      page: 1,
    }).retry,
  ).toBe(shouldRetryAPIRequest);
  for (const request of requests) {
    assertFacetRequest(request, "CZ");
  }
});
