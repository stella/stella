import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import type { api } from "@/lib/api";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/ai" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { QueryClient, QueryClientProvider, notifyManager } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { Route } = await import("./ai");
const Page = Route.options.component ?? panic("AI settings page is missing");

const USER = {
  activeOrganizationId: "billing-admin-organization",
  id: "billing-admin",
  email: "admin@example.test",
  image: null,
  name: "Admin",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const BILLING_PATH = "/v1/organization-settings/billing-drafts";
const NAVIGATION_PATH = "/v1/workspaces/navigation";
const clients: InstanceType<typeof QueryClient>[] = [];
const aiResponses: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
type BillingConfiguration = NonNullable<
  Awaited<
    ReturnType<(typeof api)["organization-settings"]["billing-drafts"]["get"]>
  >["data"]
>;

afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
  // Keep the unrelated AI provider form loading while exercising the real page.
  // Complete its transport only after unmount, so no request is left pending.
  await act(async () => {
    for (const response of aiResponses.splice(0)) {
      response.resolve(
        Response.json({
          configured: false,
          defaultModels: { chat: null, fast: null, reasoning: null, pdf: null },
          providerDefaultModels: [],
          instanceProvisioned: false,
          decisionInstanceProvisioned: false,
        } satisfies OrganizationAIConfig),
      );
    }
  });
  globalThis.fetch = originalFetch;
});
afterAll(async () => await unregisterDomEnvironment());

const mount = async (timeBilling: boolean) => {
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      switch (url.pathname) {
        case NAVIGATION_PATH:
          return Response.json({
            items: [],
            workspaces: [],
            limit: 100,
            nextCursor: null,
            features: { timeBilling },
          });
        case "/v1/organization-settings/ai-config": {
          const response = Promise.withResolvers<Response>();
          aiResponses.push(response);
          return await response.promise;
        }
        case BILLING_PATH:
          return Response.json({
            mode: "disabled",
            updatedAt: "2026-10-01T12:00:00.000Z",
            files: [],
            timeBillingFormat: "categories",
          } satisfies BillingConfiguration);
        case `${BILLING_PATH}/knowledge-files`:
          return Response.json({ items: [], nextCursor: null, limit: 20 });
        default:
          return panic("Unexpected AI settings request", url.pathname);
      }
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "owner");
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: USER }),
    component: router.Outlet,
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/admin/ai",
    component: Page,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/admin/ai"] }),
    isServer: false,
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
  });
  await appRouter.load();
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedUserProvider user={USER}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <router.RouterProvider router={appRouter} />
          </FormattingProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  const navigation = workspacesNavigationOptions({
    userId: USER.id,
    organizationId: USER.activeOrganizationId,
  });
  await act(async () => {
    await client.query(navigation);
    // Wait behind the observer notifications queued by the settled query.
    await new Promise((resolve) => {
      notifyManager.schedule(() => resolve(undefined));
    });
  });
  expect(client.getQueryState(navigation.queryKey)?.status).toBe("success");
  return { view, paths };
};

test("an unenrolled administrator sees no billing drafts card and sends no billing requests", async () => {
  const { view, paths } = await mount(false);
  expect(paths).toContain(NAVIGATION_PATH);
  expect(paths.filter((path) => path.startsWith(BILLING_PATH))).toEqual([]);
  expect(
    view.queryByRole("heading", {
      name: messages.settings.organization.billingDrafts.title,
    }),
  ).toBeNull();
});

test("an enrolled administrator loads the billing drafts card through the API client", async () => {
  const { view, paths } = await mount(true);
  expect(
    await view.findByRole("heading", {
      name: messages.settings.organization.billingDrafts.title,
    }),
  ).toBeDefined();
  expect(
    paths.filter((path) => path.startsWith(BILLING_PATH)).toSorted(),
  ).toEqual([BILLING_PATH, `${BILLING_PATH}/knowledge-files`].toSorted());
});
