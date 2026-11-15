import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import en from "@/i18n/langs/en.json";
import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";

GlobalRegistrator.register({ url: "http://localhost:3000/page" });
const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { sessionOptions } = await import("@/lib/auth-queries");
const { RouteErrorLifecycleProvider } =
  await import("@/lib/analytics/route-error-lifecycle-context");
const { DefaultErrorComponent } = await import("./route-components");

afterEach(() => {
  testing.cleanup();
});

afterAll(async () => await unregisterDomEnvironment());

const controller = {
  caught: () => undefined,
  routeResolved: () => undefined,
  retryStarted: async () => undefined,
  shown: () => undefined,
  updateInspectorState: () => undefined,
} satisfies RouteErrorLifecycleController;

/** Renders `/page` with the app's route error page and returns its view. */
const renderPage = (page: {
  loader?: () => Promise<string>;
  component: () => ReactElement;
}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The error page asks who is signed in; answer from the cache.
  queryClient.setQueryData(sessionOptions.queryKey, null);
  const root = router.createRootRoute();
  const pageRoute = router.createRoute({
    getParentRoute: () => root,
    path: "/page",
    ...(page.loader ? { loader: page.loader } : {}),
    component: page.component,
    errorComponent: DefaultErrorComponent,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/page"] }),
    isServer: false,
    routeTree: root.addChildren([pageRoute]),
  });
  return testing.render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <RouteErrorLifecycleProvider controller={controller}>
          <router.RouterProvider router={appRouter} />
        </RouteErrorLifecycleProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const tryAgain = async (view: ReturnType<typeof testing.render>) => {
  const button = await view.findByRole("button", {
    name: en.common.tryAgain,
  });
  // The button acts once the page has its support reference.
  await testing.waitFor(() => {
    expect(view.queryByText("—") === null).toBe(true);
  });
  testing.fireEvent.click(button);
};

test("Try again runs a failed loader again and shows the page", async () => {
  let loads = 0;
  const view = renderPage({
    loader: async () => {
      loads += 1;
      if (loads === 1) {
        throw new Error("The first read failed");
      }
      return "loaded";
    },
    component: () => <p data-testid="page" />,
  });
  await view.findByText(en.routeError.title);

  await tryAgain(view);

  await view.findByTestId("page");
  expect(loads).toBe(2);
});

test("Try again renders a page whose render failed without loading it again", async () => {
  let loads = 0;
  // React renders a failed tree again before it gives up, so the page stays
  // broken until the test mends it.
  let broken = true;
  const view = renderPage({
    loader: async () => {
      loads += 1;
      return "loaded";
    },
    component: () => {
      if (broken) {
        throw new Error("The render failed");
      }
      return <p data-testid="page" />;
    },
  });
  await view.findByText(en.routeError.title);

  broken = false;
  await tryAgain(view);

  await view.findByTestId("page");
  expect(loads).toBe(1);
});
