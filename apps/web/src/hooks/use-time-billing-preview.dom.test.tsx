import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_BETA_FEATURES_ENABLED: "true",
});

const originalFetch = globalThis.fetch;
// Auth client imports start the boot prefetch before the per-test transport.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { GlobalTimer } = await import("@/features/time-timers/global-timer");
const {
  isTimeBillingPreviewEnabled,
  isTimeBillingRouteEnabled,
  prefetchTimeBillingServerState,
  useTimeBillingPreviewEnabled,
} = await import("@/hooks/use-time-billing-preview");
const { Route: BetaRoute } =
  await import("@/routes/_protected.settings/account.beta");

// The caller the shell renders as (see renderShell).
const CALLER = { userId: "member", organizationId: "org-a" };

const DEPLOYMENT_FEATURES_PATH =
  "/v1/organization-settings/deployment-features";
const FEATURE_ENROLMENTS_PATH = "/v1/organization-settings/feature-enrolments";
const TIME_TIMERS_PATH = "/v1/time-timers";

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  });
  await GlobalRegistrator.unregister();
});

/** Serves the caller's decision and offered enrolments, recording requests. */
const serve = ({
  enrolled = false,
  offered = true,
  failRead = false,
  failWrite = false,
  beforeWrite,
}: {
  enrolled?: boolean;
  offered?: boolean;
  failRead?: boolean;
  failWrite?: boolean;
  beforeWrite?: () => Promise<unknown>;
} = {}) => {
  const paths: string[] = [];
  let currentEnrolment = enrolled;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      paths.push(url.pathname);
      if (
        failRead &&
        (url.pathname === DEPLOYMENT_FEATURES_PATH ||
          url.pathname === FEATURE_ENROLMENTS_PATH)
      ) {
        return Response.json({ message: "unavailable" }, { status: 503 });
      }
      if (url.pathname === DEPLOYMENT_FEATURES_PATH) {
        return Response.json({ timeBilling: offered && currentEnrolment });
      }
      if (url.pathname === FEATURE_ENROLMENTS_PATH) {
        return Response.json({
          features: offered
            ? [{ featureId: "time-billing", enrolled: currentEnrolment }]
            : [],
        });
      }
      if (url.pathname === `${FEATURE_ENROLMENTS_PATH}/time-billing`) {
        await beforeWrite?.();
        if (failWrite) {
          return Response.json({ message: "unavailable" }, { status: 503 });
        }
        currentEnrolment = method === "PUT";
        return Response.json({
          featureId: "time-billing",
          enrolled: currentEnrolment,
        });
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

describe("time billing access follows the caller's server decision", () => {
  test("the kill switch hides surfaces, avoids timer requests, and hides enrolment", async () => {
    const paths = serve({ offered: false, enrolled: true });
    const view = renderShell(newQueryClient());

    await waitFor(() => expect(paths).toContain(FEATURE_ENROLMENTS_PATH));
    await settle();

    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
    expect(view.queryAllByText(messages.common.timeBilling)).toHaveLength(0);
  });

  test("unenrolled callers may opt in but cannot load billing routes", async () => {
    const paths = serve();
    const queryClient = newQueryClient();
    await prefetchTimeBillingServerState({
      queryClient,
      caller: CALLER,
      onError: (error) => {
        throw error;
      },
    });
    expect(await isTimeBillingRouteEnabled(queryClient, CALLER)).toBe(false);
    expect(await isTimeBillingPreviewEnabled(queryClient, CALLER)).toBe(false);
    const view = renderShell(queryClient);
    await waitFor(() =>
      expect(
        view.getAllByText(messages.common.timeBilling).length,
      ).toBeGreaterThan(0),
    );
    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
  });

  test("enrolled callers load billing routes and poll timers without a browser preference", async () => {
    const paths = serve({ enrolled: true });
    const queryClient = newQueryClient();
    expect(await isTimeBillingRouteEnabled(queryClient, CALLER)).toBe(true);
    expect(await isTimeBillingPreviewEnabled(queryClient, CALLER)).toBe(true);
    const view = renderShell(queryClient);
    await waitFor(() =>
      expect(view.getByTestId("offer").textContent).toBe("true"),
    );
    await waitFor(() => expect(paths).toContain(TIME_TIMERS_PATH));
  });

  test("opting in and out reconciles navigation with the server", async () => {
    const paths = serve();
    const view = renderShell(newQueryClient());
    await waitFor(() =>
      expect(
        view.getAllByText(messages.common.timeBilling).length,
      ).toBeGreaterThan(0),
    );
    const billingCheckbox = view.getByRole("checkbox", {
      name: messages.common.timeBilling,
    });
    fireEvent.click(billingCheckbox);
    await waitFor(() =>
      expect(view.getByTestId("offer").textContent).toBe("true"),
    );
    expect(paths).toContain(`${FEATURE_ENROLMENTS_PATH}/time-billing`);
    await waitFor(() =>
      expect(billingCheckbox.hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(billingCheckbox);
    await waitFor(() =>
      expect(view.getByTestId("offer").textContent).toBe("false"),
    );
  });

  test("a failed enrolment rolls the optimistic checkbox back", async () => {
    const writeResponse = Promise.withResolvers();
    const paths = serve({
      failWrite: true,
      beforeWrite: async () => await writeResponse.promise,
    });
    const view = renderShell(newQueryClient());
    await waitFor(() =>
      expect(
        view.getAllByText(messages.common.timeBilling).length,
      ).toBeGreaterThan(0),
    );
    const billingCheckbox = view.getByRole("checkbox", {
      name: messages.common.timeBilling,
    });
    fireEvent.click(billingCheckbox);
    await waitFor(() =>
      expect(paths).toContain(`${FEATURE_ENROLMENTS_PATH}/time-billing`),
    );
    await waitFor(() =>
      expect(billingCheckbox.getAttribute("aria-checked")).toBe("true"),
    );
    expect(view.getByTestId("offer").textContent).toBe("false");
    writeResponse.resolve(undefined);
    await waitFor(() =>
      expect(billingCheckbox.getAttribute("aria-checked")).toBe("false"),
    );
    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
  });

  test("failed server answers offer nothing and never poll timers", async () => {
    const paths = serve({ failRead: true });
    const view = renderShell(newQueryClient());
    await waitFor(() => expect(paths).toContain(DEPLOYMENT_FEATURES_PATH));
    await settle();
    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
    expect(view.queryAllByText(messages.common.timeBilling)).toHaveLength(0);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        messages.errors.actionFailed,
      ),
    );
    expect(
      view.getByRole("button", { name: messages.common.retry }),
    ).toBeDefined();
  });
});
