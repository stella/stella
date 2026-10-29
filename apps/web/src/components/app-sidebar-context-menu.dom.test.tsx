import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const MATTER_ID = "019a0000-0000-7000-8000-000000000601";
const DOCUMENT_ID = "019a0000-0000-7000-8000-000000000602";
const entityDeletes: unknown[] = [];

beforeEach(() => {
  entityDeletes.length = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const { pathname } = new URL(request.url);
        if (pathname.endsWith(`/workspaces/${MATTER_ID}/activity`)) {
          return Response.json({
            items: [
              {
                activityAt: "2026-07-01T12:00:00.000Z",
                entityKind: "document",
                fieldId: null,
                fileName: "claim.docx",
                hasThumbnail: false,
                id: DOCUMENT_ID,
                listItemType: null,
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                status: null,
                title: "Statement of claim",
                type: "entity",
              },
            ],
            nextCursor: null,
          });
        }
        if (request.method === "DELETE") {
          entityDeletes.push({ pathname, body: await request.json() });
          return Response.json({});
        }
        throw new TypeError(
          `Unexpected sidebar request: ${request.method} ${pathname}`,
        );
      },
      { preconnect: () => undefined },
    ),
  );
});

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
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { rootKeys } = await import("@/lib/auth-query-options");
const { MatterItem } = await import("@/components/app-sidebar");
const { SidebarProvider } = await import("@/components/sidebar");
const { RouteProviderScopeBoundary } =
  await import("@/components/route-provider-scope/route-provider-scope");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");

afterEach(() => {
  cleanup();
  mock.restore();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("sidebar context menus delete only the row that was right-clicked", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient.setQueryData(rootKeys.role, "owner");
  const root = createRootRoute();
  const protectedRoute = createRoute({
    getParentRoute: () => root,
    id: "_protected",
  });
  const workspace = createRoute({
    getParentRoute: () => protectedRoute,
    path: "workspaces/$workspaceId",
    staticData: { providerScopes: ["auth"] },
    component: () => (
      <RouteProviderScopeBoundary>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "organization_sidebar",
            email: "sidebar@example.com",
            id: "user_sidebar",
            image: null,
            name: "Sidebar User",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <SidebarProvider defaultOpen>
            <MatterItem
              activeOrganizationId="organization_sidebar"
              billingLinks={[]}
              isActive
              isExpanded
              onDeleted={() => undefined}
              onExpandedChange={() => undefined}
              onTogglePin={() => undefined}
              userId="user_sidebar"
              workspace={{
                client: null,
                color: null,
                id: MATTER_ID,
                lastActivityAt: new Date("2026-07-01T12:00:00.000Z"),
                name: "Northwind matter",
                reference: null,
              }}
            />
          </SidebarProvider>
        </AuthenticatedUserProvider>
      </RouteProviderScopeBoundary>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: [`/workspaces/${MATTER_ID}`],
    }),
    isServer: false,
    routeTree: root.addChildren([protectedRoute.addChildren([workspace])]),
  });
  await router.load();

  render(
    <AnalyticsContext value={noopAnalytics}>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RouterProvider router={router} />
        </IntlProvider>
      </QueryClientProvider>
    </AnalyticsContext>,
  );

  const documentRow = await screen.findByRole("button", {
    name: /Statement of claim/u,
  });
  fireEvent.contextMenu(documentRow);
  const documentMenu = await screen.findByRole("menu");
  fireEvent.click(
    within(documentMenu).getByRole("menuitem", { name: "Delete" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

  await waitFor(() =>
    expect(entityDeletes).toEqual([
      {
        pathname: `/v1/entities/${MATTER_ID}`,
        body: { entityIds: [DOCUMENT_ID] },
      },
    ]),
  );
  expect(screen.queryByText("Northwind matter")).not.toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();

  const matterRow = document.querySelector(`[data-entity-id="${MATTER_ID}"]`);
  expect(matterRow).not.toBeNull();
  fireEvent.contextMenu(matterRow!);

  const matterMenu = await screen.findByRole("menu");
  expect(within(matterMenu).getByText("Northwind matter")).not.toBeNull();
  expect(entityDeletes).toEqual([
    {
      pathname: `/v1/entities/${MATTER_ID}`,
      body: { entityIds: [DOCUMENT_ID] },
    },
  ]);
});
