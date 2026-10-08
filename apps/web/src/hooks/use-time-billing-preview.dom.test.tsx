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
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { taskKeys } = await import("@/lib/workspaces/queries/tasks.logic");
const { GlobalTimer } = await import("@/features/time-timers/global-timer");
const {
  isTimeBillingPreviewEnabled,
  isTimeBillingRouteEnabled,
  useTimeBillingPreviewEnabled,
} = await import("@/hooks/use-time-billing-preview");
const { useInboxPreviewEnabled, isInboxPreviewEnabled } =
  await import("@/hooks/use-inbox-preview");
const { useWorkflowsPreviewEnabled, workflowsRouteAvailable } =
  await import("@/hooks/use-workflows-preview");
const { Route: BetaRoute } =
  await import("@/routes/_protected.settings/account.beta");

// The caller the shell renders as (see renderShell).
const CALLER = { userId: "member", organizationId: "org-a" };

const WORKSPACES_NAVIGATION_PATH = "/v1/workspaces/navigation";
const DEPLOYMENT_FEATURES_PATH =
  "/v1/organization-settings/deployment-features";
const FEATURE_ENROLMENTS_PATH = "/v1/organization-settings/feature-enrolments";
const TIME_TIMERS_PATH = "/v1/time-timers";
const expectNoDeploymentFeaturesRequest = (paths: string[]) => {
  expect(paths).not.toContain(DEPLOYMENT_FEATURES_PATH);
};

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

/** Serves the caller's navigation decision and enrolments, recording requests. */
const serve = ({
  enrolled = false,
  featureId = "time-billing",
  offered = true,
  failRead = false,
  failWrite = false,
  beforeWrite,
}: {
  enrolled?: boolean;
  featureId?: "time-billing" | "signals" | "flows";
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
        (url.pathname === WORKSPACES_NAVIGATION_PATH ||
          url.pathname === FEATURE_ENROLMENTS_PATH)
      ) {
        return Response.json({ message: "unavailable" }, { status: 503 });
      }
      if (url.pathname === WORKSPACES_NAVIGATION_PATH) {
        return Response.json({
          items: [],
          workspaces: [],
          limit: 100,
          nextCursor: null,
          features: {
            timeBilling:
              featureId === "time-billing" && offered && currentEnrolment,
            signals: featureId === "signals" && offered && currentEnrolment,
            flows: featureId === "flows" && offered && currentEnrolment,
          },
        });
      }
      if (url.pathname === FEATURE_ENROLMENTS_PATH) {
        return Response.json({
          features: offered ? [{ featureId, enrolled: currentEnrolment }] : [],
        });
      }
      if (url.pathname === `${FEATURE_ENROLMENTS_PATH}/${featureId}`) {
        await beforeWrite?.();
        if (failWrite) {
          return Response.json({ message: "unavailable" }, { status: 503 });
        }
        currentEnrolment = method === "PUT";
        return Response.json({
          featureId,
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
    React.Fragment,
    {},
    React.createElement(
      "output",
      { "data-testid": "signals-offer" },
      String(useInboxPreviewEnabled()),
    ),
    React.createElement(
      "output",
      { "data-testid": "flows-offer" },
      String(useWorkflowsPreviewEnabled()),
    ),
    React.createElement(
      "output",
      { "data-testid": "offer" },
      String(useTimeBillingPreviewEnabled()),
    ),
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

    await waitFor(() => expect(paths).toContain(WORKSPACES_NAVIGATION_PATH));
    await settle();

    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
    expectNoDeploymentFeaturesRequest(paths);
    expect(view.queryAllByText(messages.common.timeBilling)).toHaveLength(0);
  });

  test("unenrolled callers may opt in but cannot load billing routes", async () => {
    const paths = serve();
    const queryClient = newQueryClient();
    await queryClient.query(workspacesNavigationOptions(CALLER));
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
    expect(
      paths.filter((path) => path === WORKSPACES_NAVIGATION_PATH),
    ).toHaveLength(1);
    expectNoDeploymentFeaturesRequest(paths);
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
    expect(
      paths.filter((path) => path === WORKSPACES_NAVIGATION_PATH),
    ).toHaveLength(1);
    expectNoDeploymentFeaturesRequest(paths);
  });

  test("caller navigation decisions stay isolated by user and organization", async () => {
    const paths = serve();
    const queryClient = newQueryClient();
    const otherCaller = { userId: "member-2", organizationId: "org-b" };
    queryClient.setQueryData(workspacesNavigationOptions(CALLER).queryKey, {
      workspaces: [],
      features: { timeBilling: false, signals: false, flows: false },
    });
    queryClient.setQueryData(
      workspacesNavigationOptions(otherCaller).queryKey,
      {
        workspaces: [],
        features: { timeBilling: true, signals: true, flows: true },
      },
    );

    expect(await isTimeBillingPreviewEnabled(queryClient, CALLER)).toBe(false);
    expect(await isTimeBillingPreviewEnabled(queryClient, otherCaller)).toBe(
      true,
    );
    expect(await isInboxPreviewEnabled(queryClient, CALLER)).toBe(false);
    expect(await isInboxPreviewEnabled(queryClient, otherCaller)).toBe(true);
    expect(await workflowsRouteAvailable(queryClient, CALLER)).toBe(false);
    expect(await workflowsRouteAvailable(queryClient, otherCaller)).toBe(true);
    expect(paths).toHaveLength(0);
    expect(workspacesNavigationOptions(CALLER).queryKey).not.toEqual(
      workspacesNavigationOptions({ ...CALLER, organizationId: "org-c" })
        .queryKey,
    );
    expect(workspacesNavigationOptions(CALLER).queryKey).not.toEqual(
      workspacesNavigationOptions({ ...CALLER, userId: "member-3" }).queryKey,
    );
    expectNoDeploymentFeaturesRequest(paths);
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
      expect(
        paths.filter((path) => path === WORKSPACES_NAVIGATION_PATH).length,
      ).toBeGreaterThan(1),
    );
    await waitFor(() =>
      expect(billingCheckbox.hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(billingCheckbox);
    await waitFor(() =>
      expect(view.getByTestId("offer").textContent).toBe("false"),
    );
    expectNoDeploymentFeaturesRequest(paths);
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
    expectNoDeploymentFeaturesRequest(paths);
    expect(paths).not.toContain(TIME_TIMERS_PATH);
  });

  test("failed server answers offer nothing and never poll timers", async () => {
    const paths = serve({ failRead: true });
    const view = renderShell(newQueryClient());
    await waitFor(() => expect(paths).toContain(WORKSPACES_NAVIGATION_PATH));
    await settle();
    expect(view.getByTestId("offer").textContent).toBe("false");
    expect(view.getByTestId("signals-offer").textContent).toBe("false");
    expect(view.getByTestId("flows-offer").textContent).toBe("false");
    expect(paths).not.toContain(TIME_TIMERS_PATH);
    expectNoDeploymentFeaturesRequest(paths);
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

test("anonymous chrome hides account features without requesting navigation", async () => {
  const paths = serve({ enrolled: true });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client: newQueryClient() },
      React.createElement(OfferProbe),
    ),
  );
  await settle();
  expect(view.getByTestId("offer").textContent).toBe("false");
  expect(view.getByTestId("signals-offer").textContent).toBe("false");
  expect(view.getByTestId("flows-offer").textContent).toBe("false");
  expect(paths).not.toContain(WORKSPACES_NAVIGATION_PATH);
});

for (const feature of [
  {
    id: "signals",
    label: messages.settings.account.betaInbox,
    routeEnabled: isInboxPreviewEnabled,
  },
  {
    id: "flows",
    label: messages.common.workflows,
    routeEnabled: workflowsRouteAvailable,
  },
] as const) {
  describe(`${feature.id} server-owned beta enrolment`, () => {
    test("the deployment off-switch hides its setting and route", async () => {
      const paths = serve({
        featureId: feature.id,
        offered: false,
        enrolled: true,
      });
      const queryClient = newQueryClient();
      const view = renderShell(queryClient);
      await waitFor(() => expect(paths).toContain(FEATURE_ENROLMENTS_PATH));
      await settle();
      expect(view.getByTestId(`${feature.id}-offer`).textContent).toBe("false");
      expect(view.queryByRole("checkbox", { name: feature.label })).toBeNull();
      expect(await feature.routeEnabled(queryClient, CALLER)).toBe(false);
      expectNoDeploymentFeaturesRequest(paths);
    });

    test("opting in and out reconciles its route and chrome with the server", async () => {
      const paths = serve({ featureId: feature.id });
      const queryClient = newQueryClient();
      const view = renderShell(queryClient);
      const checkbox = await view.findByRole("checkbox", {
        name: feature.label,
      });
      expect(await feature.routeEnabled(queryClient, CALLER)).toBe(false);
      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(view.getByTestId(`${feature.id}-offer`).textContent).toBe(
          "true",
        ),
      );
      expect(paths).toContain(`${FEATURE_ENROLMENTS_PATH}/${feature.id}`);
      expect(await feature.routeEnabled(queryClient, CALLER)).toBe(true);
      await waitFor(() =>
        expect(checkbox.hasAttribute("disabled")).toBe(false),
      );
      const taskKey = taskKeys.detail("matter-a", "ordinary-task");
      queryClient.setQueryData(taskKey, { linkedReview: "private review" });
      expect(queryClient.getQueryData(taskKey)).toBeDefined();
      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(view.getByTestId(`${feature.id}-offer`).textContent).toBe(
          "false",
        ),
      );
      expect(await feature.routeEnabled(queryClient, CALLER)).toBe(false);
      expect(queryClient.getQueryData(taskKey)).toBeUndefined();
      expectNoDeploymentFeaturesRequest(paths);
    });
  });
}

test("a failed feature toggle preserves another pending feature toggle", async () => {
  const flowsResponse = Promise.withResolvers();
  const signalsResponse = Promise.withResolvers();
  let signalsEnrolled = false;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === FEATURE_ENROLMENTS_PATH) {
        return Response.json({
          features: [
            { featureId: "flows", enrolled: false },
            { featureId: "signals", enrolled: signalsEnrolled },
          ],
        });
      }
      if (url.pathname === WORKSPACES_NAVIGATION_PATH) {
        return Response.json({
          workspaces: [],
          items: [],
          limit: 100,
          nextCursor: null,
          features: {
            timeBilling: false,
            flows: false,
            signals: signalsEnrolled,
          },
        });
      }
      if (url.pathname === `${FEATURE_ENROLMENTS_PATH}/flows`) {
        await flowsResponse.promise;
        return Response.json({ message: "unavailable" }, { status: 503 });
      }
      if (url.pathname === `${FEATURE_ENROLMENTS_PATH}/signals`) {
        await signalsResponse.promise;
        signalsEnrolled = true;
        return Response.json({ featureId: "signals", enrolled: true });
      }
      return Response.json(null);
    },
    { preconnect: () => undefined },
  );
  const view = renderShell(newQueryClient());
  const flowsCheckbox = await view.findByRole("checkbox", {
    name: messages.common.workflows,
  });
  const signalsCheckbox = await view.findByRole("checkbox", {
    name: messages.settings.account.betaInbox,
  });
  fireEvent.click(flowsCheckbox);
  await waitFor(() =>
    expect(flowsCheckbox.getAttribute("aria-checked")).toBe("true"),
  );
  fireEvent.click(signalsCheckbox);
  await waitFor(() =>
    expect(signalsCheckbox.getAttribute("aria-checked")).toBe("true"),
  );
  await act(async () => {
    flowsResponse.resolve(undefined);
    await flowsResponse.promise;
  });
  await waitFor(() =>
    expect(flowsCheckbox.getAttribute("aria-checked")).toBe("false"),
  );
  await settle();
  const pendingSignalsChecked = signalsCheckbox.getAttribute("aria-checked");
  await act(async () => {
    signalsResponse.resolve(undefined);
    await signalsResponse.promise;
  });
  await waitFor(() =>
    expect(view.getByTestId("signals-offer").textContent).toBe("true"),
  );
  expect(pendingSignalsChecked).toBe("true");
});
