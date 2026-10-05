import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
// A production-shaped web build: beta previews available, time billing not
// shipped by the build, so only the per-browser preview can ask for it.
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_BETA_FEATURES_ENABLED: "true",
  VITE_FEATURE_TIME_BILLING: "false",
});

const originalFetch = globalThis.fetch;
// Auth client imports start the boot prefetch before the per-test transport.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useDevStore } = await import("@/lib/dev-store");
const { GlobalTimer } = await import("@/features/time-timers/global-timer");
const {
  isTimeBillingPreviewEnabled,
  isTimeBillingRouteEnabled,
  prefetchTimeBillingServerState,
  useTimeBillingPreviewEnabled,
} = await import("@/hooks/use-time-billing-preview");
const { Route: BetaRoute } =
  await import("@/routes/_protected.settings/account.beta");

const DEPLOYMENT_FEATURES_PATH =
  "/v1/organization-settings/deployment-features";
const TIME_TIMERS_PATH = "/v1/time-timers";

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useDevStore.getState().setTimeBillingPreview(false);
});

afterAll(async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  });
  await GlobalRegistrator.unregister();
});

/** Serves the deployment-features answer and records every request path. */
const serve = (deploymentFeatures: () => Response) => {
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (url.pathname === DEPLOYMENT_FEATURES_PATH) {
        return deploymentFeatures();
      }
      if (url.pathname === TIME_TIMERS_PATH) {
        return Response.json({ items: [], nextCursor: null });
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );
  return paths;
};

const serveServer = (timeBilling: boolean) =>
  serve(() => Response.json({ timeBilling }));

const newQueryClient = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  return queryClient;
};

const OfferProbe = () =>
  React.createElement(
    "output",
    { "data-testid": "offer" },
    String(useTimeBillingPreviewEnabled()),
  );

const BetaPage = BetaRoute.options.component;
if (BetaPage === undefined) {
  throw new Error("The beta settings route has no component.");
}

const renderShell = (queryClient: InstanceType<typeof QueryClient>) =>
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(IntlProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          AuthenticatedUserProvider,
          {
            user: {
              activeOrganizationId: "org-a",
              email: "member@example.test",
              id: "member",
              image: null,
              name: "Member",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            },
          },
          React.createElement(
            FormattingProvider,
            { locale: "en-GB", timeZone: "UTC" },
            React.createElement(OfferProbe),
            React.createElement(GlobalTimer),
            React.createElement(BetaPage),
          ),
        ),
      }),
    ),
  );

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  });
};

describe("time billing with the server flag off", () => {
  test("a ticked preview offers nothing, never polls timers, and hides the toggle", async () => {
    useDevStore.getState().setTimeBillingPreview(true);
    const paths = serveServer(false);
    const view = renderShell(newQueryClient());

    await waitFor(() => expect(paths).toContain(DEPLOYMENT_FEATURES_PATH));
    await settle();

    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
    expect(view.queryAllByText(messages.common.timeBilling)).toHaveLength(0);
    // The fixture reaches the gate: the other previews still render.
    expect(view.getAllByText(messages.common.workflows).length).toBeGreaterThan(
      0,
    );
  });

  test("route gates refuse without fetching any time-billing data", async () => {
    useDevStore.getState().setTimeBillingPreview(true);
    const paths = serveServer(false);
    const queryClient = newQueryClient();

    expect(await isTimeBillingRouteEnabled(queryClient)).toBe(false);
    expect(await isTimeBillingPreviewEnabled(queryClient)).toBe(false);
    expect(paths).toEqual([DEPLOYMENT_FEATURES_PATH]);
  });

  test("an unticked preview never asks the server", async () => {
    const paths = serveServer(true);
    const queryClient = newQueryClient();

    await prefetchTimeBillingServerState(queryClient, (error) => {
      throw error;
    });
    expect(await isTimeBillingRouteEnabled(queryClient)).toBe(false);
    expect(await isTimeBillingPreviewEnabled(queryClient)).toBe(false);
    expect(paths).toEqual([]);
  });
});

describe("time billing with the server flag on", () => {
  test("a ticked preview offers time billing, polls timers, and shows the toggle", async () => {
    useDevStore.getState().setTimeBillingPreview(true);
    const paths = serveServer(true);
    const view = renderShell(newQueryClient());

    await waitFor(() =>
      expect(view.getByTestId("offer").textContent).toBe("true"),
    );
    await waitFor(() => expect(paths).toContain(TIME_TIMERS_PATH));
    expect(
      view.getAllByText(messages.common.timeBilling).length,
    ).toBeGreaterThan(0);
  });

  test("route gates open through the preview", async () => {
    useDevStore.getState().setTimeBillingPreview(true);
    serveServer(true);
    const queryClient = newQueryClient();

    expect(await isTimeBillingRouteEnabled(queryClient)).toBe(true);
    expect(await isTimeBillingPreviewEnabled(queryClient)).toBe(true);
  });

  test("the beta page offers the toggle before anyone ticks it", async () => {
    const paths = serveServer(true);
    const view = renderShell(newQueryClient());

    await waitFor(() =>
      expect(
        view.getAllByText(messages.common.timeBilling).length,
      ).toBeGreaterThan(0),
    );
    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
  });
});

describe("time billing when the server answer fails", () => {
  test("a ticked preview offers nothing, never polls timers, and hides the toggle", async () => {
    useDevStore.getState().setTimeBillingPreview(true);
    const paths = serve(() =>
      Response.json({ message: "unavailable" }, { status: 503 }),
    );
    const view = renderShell(newQueryClient());

    await waitFor(() => expect(paths).toContain(DEPLOYMENT_FEATURES_PATH));
    await settle();

    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
    expect(view.queryAllByText(messages.common.timeBilling)).toHaveLength(0);
  });
});
