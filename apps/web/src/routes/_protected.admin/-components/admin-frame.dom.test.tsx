import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { sleep } from "@stll/concurrency/sleep";

import type { Role } from "@/lib/auth-client";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";

GlobalRegistrator.register({ url: "http://localhost:3000/admin" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_FEATURE_USAGE: "false",
});
Object.assign(globalThis, {
  __APP_VERSION__: "0.0.0",
  __APP_COMMIT_SHA__: "test",
});
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const en = (await import("@/i18n/langs/en.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;
const { authClient } = await import("@/lib/auth-client");
const { roleOptions, sessionOptions } = await import("@/lib/auth-queries");
const { supportedLanguages } = await import("@/i18n/i18n-store");
const { AdminAppFrame } = await import("./admin-frame");

const user = {
  activeOrganizationId: "org-a",
  email: "admin@example.test",
  id: "admin-user",
  image: null,
  name: "Admin user",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;
const organizations = [
  {
    id: "org-a",
    name: "First firm",
    slug: "first-firm",
    createdAt: new Date("2026-01-01"),
  },
  {
    id: "org-b",
    name: "Second firm",
    slug: "second-firm",
    createdAt: new Date("2026-01-02"),
  },
] satisfies NonNullable<
  Awaited<ReturnType<typeof authClient.organization.list>>["data"]
>;

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await act(async () => {
    await sleep(50);
  });
  await GlobalRegistrator.unregister();
});

const serve = (role: Role) => {
  const requests: { path: string; method: string; body: string | null }[] = [];
  let activeOrganizationId = user.activeOrganizationId;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === "GET" ? null : await request.text();
      requests.push({ path, method: request.method, body });
      if (path.endsWith("/organization/list")) {
        return Response.json(organizations);
      }
      if (path.endsWith("/organization/get-active-member-role")) {
        return Response.json({ role });
      }
      if (path.endsWith("/organization/set-active")) {
        activeOrganizationId = "org-b";
        return Response.json(organizations.at(1));
      }
      if (path.endsWith("/get-session")) {
        return Response.json({
          session: {
            id: "session",
            userId: user.id,
            activeOrganizationId,
            expiresAt: "2027-01-01T00:00:00Z",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            token: "fixture-session",
          },
          user: {
            ...user,
            activeOrganizationId,
            emailVerified: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        });
      }
      if (path === "/v1/workspaces/navigation") {
        return Response.json({
          items: [],
          workspaces: [],
          limit: 100,
          nextCursor: null,
          features: { timeBilling: true },
        });
      }
      return Response.json(
        { message: `Unexpected test request: ${path}` },
        { status: 500 },
      );
    },
    { preconnect: () => undefined },
  );
  return requests;
};

const renderFrame = async (locale: "en" | "ar", role: Role) => {
  const requests = serve(role);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  await client.query(roleOptions);
  await client.query(sessionOptions);
  const messages = locale === "en" ? en : ar;
  const rootRoute = router.createRootRoute({ component: router.Outlet });
  const adminRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin",
    component: () => (
      <AdminAppFrame user={user}>
        <p data-testid="admin-content" />
      </AdminAppFrame>
    ),
  });
  const appRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p data-testid="app-destination" />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/admin"] }),
    isServer: false,
    routeTree: rootRoute.addChildren([adminRoute, appRoute]),
  });
  await appRouter.load();
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <router.RouterProvider router={appRouter} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      view.getByRole("button", {
        name: messages.organization.switchOrganization,
      }).textContent,
    ).toContain("First firm"),
  );
  return { view, appRouter, requests, messages };
};

test.each(
  supportedLanguages.filter((locale) => locale === "en" || locale === "ar"),
)(
  "admin shell preserves navigation order and translated labels in %s",
  async (locale) => {
    const { view, messages } = await renderFrame(locale, "owner");
    await waitFor(() =>
      expect(
        view.getAllByRole("link").map((link) => link.getAttribute("href")),
      ).toContain("/admin/time-policy"),
    );
    expect(
      view.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual([
      "/",
      "/admin",
      "/admin/general",
      "/admin/members",
      "/admin/ai",
      "/admin/anonymization",
      "/admin/tools",
      "/admin/usage",
      "/admin/audit-logs",
      "/admin/matter-numbering",
      "/admin/document-types",
      "/admin/time-policy",
      "/admin/number-series",
      "/admin/vat-rates",
      "/admin/billing",
      "/admin/catalogue",
    ]);
    expect(
      view
        .getByRole("link", { name: messages.admin.backToApp })
        .getAttribute("href"),
    ).toBe("/");
    expect(
      view
        .getByRole("link", { name: messages.admin.modelsAndProviders })
        .getAttribute("href"),
    ).toBe("/admin/ai");
    expect(
      view
        .getByRole("link", { name: messages.admin.planAndUsage })
        .getAttribute("href"),
    ).toBe("/admin/usage");
    expect(view.getByTestId("admin-content")).toBeDefined();
  },
);

test("admin shell organization switch refreshes the session and returns to the app", async () => {
  const { view, requests, messages, appRouter } = await renderFrame(
    "en",
    "owner",
  );
  fireEvent.click(
    view.getByRole("button", {
      name: messages.organization.switchOrganization,
    }),
  );
  const submenu = await view.findByRole("menuitem", { name: /First firm/u });
  fireEvent.keyDown(submenu, { key: "ArrowRight", code: "ArrowRight" });
  const otherOrganization = await view.findByRole("menuitemradio", {
    name: "Second firm",
  });
  fireEvent.click(otherOrganization);
  await waitFor(() => expect(appRouter.state.location.pathname).toBe("/"));
  expect(
    requests.find(({ path }) => path.endsWith("/organization/set-active")),
  ).toEqual({
    path: "/api/auth/organization/set-active",
    method: "POST",
    body: JSON.stringify({ organizationId: "org-b" }),
  });
  expect(
    requests.filter(({ path }) => path.endsWith("/get-session")).length,
  ).toBeGreaterThan(1);
  expect(view.getByTestId("app-destination")).toBeDefined();
});

test.each(ORGANIZATION_ROLE_NAMES)(
  "account menu admits only organization managers: %s",
  async (role) => {
    const { view, messages } = await renderFrame("en", role);
    fireEvent.click(view.getByRole("button", { name: /Admin user/u }));
    await view.findByRole("menuitem", { name: messages.common.settings });
    expect(
      view.queryByRole("menuitem", { name: messages.admin.title }) !== null,
    ).toBe(role === "owner" || role === "admin");
  },
);
