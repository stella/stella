import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { propertiesOptions } =
  await import("@/lib/workspaces/queries/properties");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { BulkAddColumns } = await import("./bulk-add-columns");

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

test("member can change a manual bulk draft's content type and save while AI drafts stay gated", async () => {
  const writes: unknown[] = [];
  const unexpectedRequests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/properties/matter")) {
        return Response.json([]);
      }
      if (
        request.method === "GET" &&
        path.endsWith("/organization-settings/ai-availability")
      ) {
        return Response.json({
          available: false,
          deferredServiceTierAvailable: false,
        });
      }
      if (
        request.method === "PUT" &&
        path.endsWith("/properties/matter/batch")
      ) {
        const body: unknown = await request.json();
        writes.push(body);
        return Response.json([]);
      }
      if (request.method === "GET" && path.endsWith("/skills")) {
        return Response.json({ builtIn: [], installed: [], nextCursor: null });
      }
      if (
        request.method === "GET" &&
        path.endsWith("/chat/skill-availability")
      ) {
        return Response.json({ unavailable: [] });
      }
      unexpectedRequests.push(`${request.method} ${path}`);
      return Response.json(
        { message: "Unexpected test request" },
        { status: 500 },
      );
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(propertiesOptions("matter").queryKey, []);
  const capabilities = resolveActionCapabilities({
    role: "member",
    ai: false,
    deepl: false,
    ocr: false,
    desktop: "none",
    settings: undefined,
  });
  expect(capabilities.capabilities.ai.type).toBe("unavailable");
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { activeOrganizationId: "organization-a" } }),
    component: router.Outlet,
  });
  const route = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/",
    component: () => (
      <BulkAddColumns
        target={{ kind: "workspace", workspaceId: "matter" }}
        triggerVariant="labelled"
      />
    ),
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([protectedRoute.addChildren([route])]),
    isServer: false,
  });
  await appRouter.load();
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ActionCapabilitiesProvider value={capabilities}>
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider
              user={{
                activeOrganizationId: "organization-a",
                email: "member@example.com",
                id: "member",
                image: null,
                name: "Member",
                preferredName: null,
                timezoneId: "UTC",
                wordEditShortcut: null,
              }}
            >
              <router.RouterProvider router={appRouter} />
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </ActionCapabilitiesProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await act(async () => {
    fireEvent.click(
      await screen.findByRole("button", {
        name: messages.workspaces.properties.newColumn,
      }),
    );
  });
  const name = await screen.findByPlaceholderText(
    messages.workspaces.properties.newColumnName,
  );
  await act(async () => {
    fireEvent.change(name, { target: { value: "Manual count" } });
  });
  expect(
    screen.queryByRole("button", {
      name: messages.workspaces.properties.chipNumber,
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: messages.workspaces.properties.bulk.title,
    }),
  ).toBeNull();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.workspaces.properties.chipManual,
      }),
    );
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.workspaces.properties.chipNumber,
      }),
    );
  });
  const save = screen.getByRole("button", {
    name: messages.workspaces.properties.bulk.title,
  });
  expect(save.hasAttribute("disabled")).toBe(false);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.workspaces.properties.bulk.addAnother,
      }),
    );
  });
  const aiName =
    screen
      .getAllByPlaceholderText(messages.workspaces.properties.newColumnName)
      .at(1) ?? panic("Second draft is missing");
  await act(async () => {
    fireEvent.change(aiName, { target: { value: "AI count" } });
  });
  // A valid AI draft gates the mixed batch; its content-type controls stay hidden.
  expect(
    screen.getAllByRole("button", {
      name: messages.workspaces.properties.chipNumber,
    }),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("button", {
      name: messages.workspaces.properties.bulk.title,
    }),
  ).toBeNull();
  await act(async () => {
    fireEvent.change(aiName, { target: { value: "" } });
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.workspaces.properties.bulk.title,
      }),
    );
  });
  await waitFor(() => {
    expect(writes).toEqual([
      {
        items: [
          {
            name: "Manual count",
            contentType: "int",
            toolType: "manual-input",
          },
        ],
      },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(unexpectedRequests).toEqual([]);
});
