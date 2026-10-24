import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { Role } from "@/lib/auth-client";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/general" });
// Beta availability otherwise reads the request host through the server
// runtime; the deployment switch decides it here.
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_BETA_FEATURES_ENABLED: "true",
});
const originalFetch = globalThis.fetch;

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const en = (await import("@/i18n/langs/en.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;
const { roleOptions } = await import("@/lib/auth-queries");
const { supportedLanguages } = await import("@/i18n/i18n-store");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { SettingsShell } = await import("./settings-shell");

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
  await unregisterDomEnvironment();
});

const serve = (role: Role) => {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/organization/get-active-member-role")) {
        return Response.json({ role });
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
};

const renderShell = async (locale: "en" | "ar", role: Role) => {
  serve(role);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  await client.query(roleOptions);
  const messages = locale === "en" ? en : ar;
  const rootRoute = router.createRootRoute({
    component: () => (
      <SettingsShell>
        <p data-testid="settings-content" />
      </SettingsShell>
    ),
  });
  const pageRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({
      initialEntries: ["/admin/general"],
    }),
    isServer: false,
    routeTree: rootRoute.addChildren([pageRoute]),
  });
  await appRouter.load();
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider user={user}>
          <router.RouterProvider router={appRouter} />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await view.findByTestId("settings-content");
  return { view, messages };
};

const hrefs = (view: Awaited<ReturnType<typeof renderShell>>["view"]) =>
  view.getAllByRole("link").map((link) => link.getAttribute("href"));

test.each(
  supportedLanguages.filter((locale) => locale === "en" || locale === "ar"),
)(
  "account and organization share one translated navigation in %s",
  async (locale) => {
    const { view, messages } = await renderShell(locale, "owner");
    await waitFor(() => expect(hrefs(view)).toContain("/admin/time-policy"));
    expect(hrefs(view)).toEqual([
      "/settings/account/profile",
      "/settings/account/desktop",
      "/settings/account/connections",
      "/settings/account/beta",
      "/admin/general",
      "/admin/members",
      "/admin/usage",
      "/admin/audit-logs",
      "/admin/ai",
      "/admin/anonymization",
      "/admin/tools",
      "/admin/matter-numbering",
      "/admin/document-types",
      "/admin/time-policy",
      "/admin/number-series",
      "/admin/vat-rates",
      "/admin/billing",
    ]);
    expect(
      view
        .getByRole("link", { name: messages.admin.modelsAndProviders })
        .getAttribute("href"),
    ).toBe("/admin/ai");
    expect(
      view
        .getByRole("link", { name: messages.admin.general })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      view
        .getByRole("link", { name: messages.common.members })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(
      view.getByRole("button", {
        name: messages.navigation.shortcutsDialog.title,
      }),
    ).toBeDefined();
  },
);

test("members without management access see only their account", async () => {
  const { view } = await renderShell("en", "member");
  await waitFor(() =>
    expect(hrefs(view)).toContain("/settings/account/profile"),
  );
  expect(hrefs(view).filter((href) => href?.startsWith("/admin"))).toEqual([]);
});
