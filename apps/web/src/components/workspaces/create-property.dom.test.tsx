import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import type { WorkspaceProperty } from "@/lib/types";

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
const { toSafeId } = await import("@/lib/safe-id");
const { CreateProperty } = await import("./create-property");

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
  await GlobalRegistrator.unregister();
});

type BuiltInTriggerVariant = Exclude<
  NonNullable<ComponentProps<typeof CreateProperty>["triggerVariant"]>,
  "none"
>;
const triggerVariants = {
  labelled: "labelled",
  icon: "icon",
  panel: "panel",
  "blank-cell": "blank-cell",
  rail: "rail",
} as const satisfies { [Variant in BuiltInTriggerVariant]: Variant };

for (const triggerVariant of Object.values(triggerVariants)) {
  test(`${triggerVariant}: member can open and save an existing manual column while AI is unavailable`, async () => {
    const property = {
      id: toSafeId<"property">("manual-column"),
      workspaceId: toSafeId<"workspace">("matter"),
      name: "Manual notes",
      createdAt: "2026-01-01T00:00:00.000Z",
      kinds: null,
      status: "fresh",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
    } satisfies WorkspaceProperty;
    const aiProperty = {
      ...property,
      id: toSafeId<"property">("ai-column"),
      name: "AI notes",
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Extract notes",
        dependencies: [],
      },
    } satisfies WorkspaceProperty;
    let savedName = property.name;
    const updates: unknown[] = [];
    const unexpectedRequests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path.endsWith("/properties/matter")) {
          return Response.json([{ ...property, name: savedName }, aiProperty]);
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
          request.method === "POST" &&
          path.endsWith("/properties/matter/property/manual-column")
        ) {
          const body: unknown = await request.json();
          updates.push(body);
          savedName = "Updated manual notes";
          return Response.json(null);
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
        <>
          <CreateProperty
            workspaceId="matter"
            propertyId="manual-column"
            triggerVariant={triggerVariant}
          />
          <CreateProperty
            workspaceId="matter"
            propertyId="ai-column"
            triggerVariant={triggerVariant}
          />
          <CreateProperty
            workspaceId="matter"
            triggerVariant={triggerVariant}
          />
        </>
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
              <router.RouterProvider router={appRouter} />
            </FormattingProvider>
          </ActionCapabilitiesProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByRole("button", {
      name:
        triggerVariant === "panel"
          ? messages.workspaces.properties.extractEntityType
          : messages.workspaces.properties.newColumn,
    });
    // Only the manual edit is admitted; AI edit and creation stay hidden.
    expect(screen.getAllByRole("button")).toEqual([trigger]);
    expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(
      await screen.findByRole("dialog", {
        name: messages.workspaces.properties.editColumn,
      }),
    ).toBeTruthy();
    const name = await screen.findByDisplayValue(property.name);
    await act(async () => {
      fireEvent.change(name, { target: { value: "Updated manual notes" } });
    });
    const save = screen.getByRole("button", {
      name: messages.common.saveChanges,
    });
    expect(save.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => {
      expect(updates).toEqual([
        {
          name: "Updated manual notes",
          content: property.content,
          tool: property.tool,
        },
      ]);
      const cachedProperties = client.getQueryData(
        propertiesOptions("matter").queryKey,
      );
      if (cachedProperties === undefined) {
        panic("Updated properties are missing from the cache");
      }
      expect(cachedProperties).toEqual([
        { ...property, name: "Updated manual notes" },
        aiProperty,
      ]);
      expect(
        screen.queryByRole("dialog", {
          name: messages.workspaces.properties.editColumn,
        }) === null,
      ).toBe(true);
    });
    expect(unexpectedRequests).toEqual([]);
  });
}
