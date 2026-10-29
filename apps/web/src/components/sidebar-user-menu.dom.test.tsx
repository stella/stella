import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { settingsNavSections } from "@/components/settings-shell/settings-nav";
import messages from "@/i18n/langs/en.json";
import type { Role } from "@/lib/auth-client";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
for (const name of ["__APP_VERSION__", "__APP_COMMIT_SHA__"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: "test",
  });
}

const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { SidebarProvider } = await import("@/components/sidebar");
const { SidebarUserMenu } = await import("@/components/sidebar-user-menu");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { roleOptions } = await import("@/lib/auth-queries");
const { organizationListOptions } = await import("@/lib/organization/queries");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  Reflect.deleteProperty(globalThis, "__APP_VERSION__");
  Reflect.deleteProperty(globalThis, "__APP_COMMIT_SHA__");
  await unregisterDomEnvironment();
});

const USER = {
  activeOrganizationId: "organization-user-menu",
  email: "user@example.test",
  id: "user-user-menu",
  image: null,
  name: "Menu User",
};

const accessFor = (role: Role) => ({
  role,
  memory: true,
  beta: true,
  timeBilling: true,
  usage: true,
});

const renderUserMenu = async (role: Role) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(roleOptions.queryKey, role);
  queryClient.setQueryData(organizationListOptions(USER.id).queryKey, [
    {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: USER.activeOrganizationId,
      name: "Example organization",
      slug: "example-organization",
    },
  ]);

  const root = createRootRoute({
    component: () => (
      <AnalyticsContext value={noopAnalytics}>
        <QueryClientProvider client={queryClient}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <SidebarProvider defaultOpen>
              <SidebarUserMenu user={USER} />
            </SidebarProvider>
          </IntlProvider>
        </QueryClientProvider>
      </AnalyticsContext>
    ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
    routeTree: root.addChildren([settings]),
  });
  await router.load();
  render(<RouterProvider router={router} />);

  fireEvent.click(screen.getByRole("button", { name: /Menu User/u }));
  const menu = await screen.findByRole("menu");
  return { menu, router };
};

test.each<Role>(["member", "admin", "owner"])(
  "the %s user menu has one Settings destination and no admin destination",
  async (role) => {
    const { menu, router } = await renderUserMenu(role);
    const menuItems = within(menu).getAllByRole("menuitem");
    const settingsItems = menuItems.filter(
      (item) => item.textContent.trim() === messages.common.settings,
    );

    expect(settingsItems).toHaveLength(1);
    expect(settingsItems[0]?.checkVisibility()).toBe(true);
    expect(
      menuItems.filter((item) => {
        const destination = item.getAttribute("href");
        return (
          destination?.startsWith("/settings") ||
          destination?.startsWith("/admin")
        );
      }),
    ).toHaveLength(0);
    expect(
      menuItems.filter((item) => /admin/iu.test(item.textContent)),
    ).toHaveLength(0);

    fireEvent.click(settingsItems[0]!);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
  },
);

test("organization settings are visible to admins", () => {
  expect(settingsNavSections(accessFor("admin")).map(({ id }) => id)).toContain(
    "organization",
  );
});

test("organization settings are visible to owners", () => {
  expect(settingsNavSections(accessFor("owner")).map(({ id }) => id)).toContain(
    "organization",
  );
});

test("organization settings are hidden from members", () => {
  expect(settingsNavSections(accessFor("member")).map(({ id }) => id)).toEqual([
    "account",
  ]);
});
