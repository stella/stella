import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  settings: {
    enableJavaScriptEvaluation: true,
    // Only trusted, locally generated router hydration scripts execute here.
    suppressInsecureJavaScriptEnvironmentWarning: true,
  },
});

const { hydrateRoot } = await import("react-dom/client");
const { act, waitFor } = await import("@testing-library/react");
const { QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { setupRouterSsrQueryIntegration } =
  await import("@tanstack/react-router-ssr-query");
const { attachRouterServerSsrUtils, bindSsrResponseToRequest } =
  await import("@tanstack/react-router/ssr/server");
const { hydrate } = await import("@tanstack/router-core/ssr/client");
const { renderSsrResponse } = await import("./ssr-renderer");
const { detached } = await import("@/lib/detached");
const {
  createAppQueryClient,
  CriticalQueryTimeoutError,
  ensureRouteQueryData,
  prefetchRouteQuery,
  shouldDehydrateServerQuery,
} = await import("@/lib/react-query");

afterAll(async () => {
  await unregisterDomEnvironment();
});

type AppQueryClient = ReturnType<typeof createAppQueryClient>;

const DECISIONS_KEY = ["decisions", 1];
const SEARCH_UNAVAILABLE = "unavailable";

const createTree = (queryClient: AppQueryClient) => {
  const root = createRootRoute({
    component: () => (
      <html lang="en">
        <head />
        <body>
          <Outlet />
        </body>
      </html>
    ),
  });
  const cases = createRoute({
    getParentRoute: () => root,
    path: "/cases",
    // The case-law loader's shape: a read slower than its deadline is an
    // outage the loader turns into route state, and the timeout cancels it.
    loader: async () => {
      const read = await ensureRouteQueryData(
        queryClient,
        {
          queryKey: DECISIONS_KEY,
          queryFn: async () => await new Promise<never>(() => {}),
        },
        { timeoutMs: 10 },
      ).catch((error: unknown) => {
        if (CriticalQueryTimeoutError.is(error)) {
          return SEARCH_UNAVAILABLE;
        }
        throw error;
      });
      return { search: read };
    },
    component: () => <main />,
  });
  return root.addChildren([cases]);
};

const createAppRouter = (
  isServer: boolean,
  tree: (
    queryClient: AppQueryClient,
  ) => ReturnType<typeof createTree> = createTree,
  path = "/cases",
) => {
  const queryClient = createAppQueryClient();
  const router = createRouter({
    routeTree: tree(queryClient),
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer,
  });
  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    wrapQueryClient: false,
    dehydrateOptions: { shouldDehydrateQuery: shouldDehydrateServerQuery },
  });
  return { queryClient, router };
};

test("a read the server gave up on does not reach the browser as an untyped error", async () => {
  const server = createAppRouter(true);
  attachRouterServerSsrUtils({ router: server.router, manifest: undefined });
  await server.router.load();
  expect(server.queryClient.getQueryState(DECISIONS_KEY)?.status).toBe("error");
  await server.router.serverSsr?.dehydrate({
    signal: new AbortController().signal,
  });
  const request = new Request("https://stella.test/cases");
  const rendered = await renderSsrResponse({
    request,
    rendererSignal: new AbortController().signal,
    router: server.router,
    responseHeaders: new Headers({ "Content-Type": "text/html" }),
    children: <RouterProvider router={server.router} />,
    reportError: (error) => {
      throw error;
    },
  });
  if (rendered.isErr()) {
    throw rendered.error;
  }
  const html = await bindSsrResponseToRequest(
    server.router,
    rendered.value,
    request.signal,
  ).response.text();
  expect(html).not.toContain("new Error(");

  for (const [, source = ""] of html.matchAll(
    /<script[^>]*>([\s\S]*?)<\/script>/gu,
  )) {
    const script = document.createElement("script");
    script.textContent = source;
    document.body.append(script);
  }
  const client = createAppRouter(false);
  await hydrate(client.router);

  const loaderData: unknown = client.router.state.matches.at(-1)?.loaderData;
  expect(loaderData).toEqual({
    search: SEARCH_UNAVAILABLE,
  });
  expect(client.queryClient.getQueryState(DECISIONS_KEY)).toBeUndefined();
});

const SHELF_KEY = ["statutes", "shelf", { country: "CZE" }];
const SHELF_TITLE = "Civil Code";
let inBrowser = false;
const shelfOptions = {
  queryKey: SHELF_KEY,
  // The server read never answers on its own: the server cancels it after
  // the payload has left, as a loader deadline or the render teardown does.
  queryFn: async () =>
    inBrowser ? [SHELF_TITLE] : await new Promise<never>(() => {}),
};

const Shelf = () => {
  const { data } = useQuery(shelfOptions);
  return <main>{data?.join(", ") ?? "Loading"}</main>;
};

const createShelfTree = (queryClient: AppQueryClient) => {
  const root = createRootRoute({
    component: () => (
      <html lang="en">
        <head />
        <body>
          <QueryClientProvider client={queryClient}>
            <Outlet />
          </QueryClientProvider>
        </body>
      </html>
    ),
  });
  const law = createRoute({
    getParentRoute: () => root,
    path: "/law",
    // A read that does not hold the page back: it starts on the server and
    // is still in flight when the payload is built.
    loader: () => {
      detached(
        prefetchRouteQuery(queryClient, shelfOptions, () => {}),
        "test.shelf-prefetch",
      );
      return null;
    },
    component: Shelf,
  });
  return root.addChildren([law]);
};

test("a read the server cancels after its payload left is fetched again by the browser", async () => {
  const server = createAppRouter(true, createShelfTree, "/law");
  attachRouterServerSsrUtils({ router: server.router, manifest: undefined });
  await server.router.load();
  expect(server.queryClient.getQueryState(SHELF_KEY)?.status).toBe("pending");
  await server.router.serverSsr?.dehydrate({
    signal: new AbortController().signal,
  });
  const request = new Request("https://stella.test/law");
  const rendered = await renderSsrResponse({
    request,
    rendererSignal: new AbortController().signal,
    router: server.router,
    responseHeaders: new Headers({ "Content-Type": "text/html" }),
    children: <RouterProvider router={server.router} />,
    reportError: (error) => {
      throw error;
    },
  });
  if (rendered.isErr()) {
    throw rendered.error;
  }
  const body = bindSsrResponseToRequest(
    server.router,
    rendered.value,
    request.signal,
  ).response.text();
  await server.queryClient.cancelQueries(
    { queryKey: SHELF_KEY },
    { revert: false },
  );
  const html = await body;
  expect(html).toContain("Loading");

  const parsed = new DOMParser().parseFromString(html, "text/html");
  // safe-html: Generated by React from the trusted JSX fixture above; no external input.
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
  document.documentElement.lang = parsed.documentElement.lang;
  // Parsed scripts are inert; reconnect fresh ones to run the router payload.
  for (const inert of document.querySelectorAll("script")) {
    const script = document.createElement("script");
    script.textContent = inert.textContent;
    inert.replaceWith(script);
  }
  inBrowser = true;
  const client = createAppRouter(false, createShelfTree, "/law");
  const browserErrors: unknown[] = [];
  const unsubscribe = client.queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error") {
      browserErrors.push(event.action.error);
    }
  });
  await hydrate(client.router);
  const root = hydrateRoot(document, <RouterProvider router={client.router} />);
  try {
    await waitFor(() => {
      expect(document.querySelector("main")?.textContent).toBe(SHELF_TITLE);
    });
    expect(browserErrors).toEqual([]);
  } finally {
    unsubscribe();
    act(() => root.unmount());
  }
});
