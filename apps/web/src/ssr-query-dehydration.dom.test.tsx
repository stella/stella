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
const {
  createAppQueryClient,
  CriticalQueryTimeoutError,
  ensureRouteQueryData,
  shouldDehydrateServerQuery,
} = await import("@/lib/react-query");

afterAll(async () => {
  await unregisterDomEnvironment();
});

const DECISIONS_KEY = ["decisions", 1];
const SEARCH_UNAVAILABLE = "unavailable";

const createTree = (queryClient: ReturnType<typeof createAppQueryClient>) => {
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

const createAppRouter = (isServer: boolean) => {
  const queryClient = createAppQueryClient();
  const router = createRouter({
    routeTree: createTree(queryClient),
    history: createMemoryHistory({ initialEntries: ["/cases"] }),
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
