import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { ConditionNode } from "@stll/conditions";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";
import type { WorkspaceView } from "@/lib/types";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { ViewToolbarChrome } = await import("@stll/ui/view-toolbar-shell");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { propertiesQueryRoot } =
  await import("@/lib/resource-query-roots.logic");
const { toSafeId } = await import("@/lib/safe-id");
const { ViewToolbar } = await import("./view-toolbar");
const { ViewToolbarFace } = await import("./view-toolbar.pending");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000aa";
const PROPERTY_ID = toSafeId<"property">("subject");

const user = {
  activeOrganizationId: "00000000-0000-7000-8000-00000000ffff",
  id: "00000000-0000-7000-8000-00000000fffe",
};

// One filter and one sort on a property, so a chip of each kind is drawn.
const subjectFilter: ConditionNode = {
  type: "predicate",
  operand: { type: "property", propertyId: PROPERTY_ID },
  op: "contains",
  value: "lease",
};

const tableView: WorkspaceView<"table"> = {
  version: 1,
  id: "view-table",
  name: "Documents",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "table",
    filters: [subjectFilter],
    sorts: [{ propertyId: PROPERTY_ID, desc: false }],
    hiddenProperties: [],
    calculations: [],
    columnOrder: [],
    columnPinning: [],
  },
};

const boardView: WorkspaceView<"kanban"> = {
  version: 1,
  id: "view-board",
  name: "Board",
  position: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "kanban",
    filters: [subjectFilter],
    sorts: [{ propertyId: PROPERTY_ID, desc: false }],
    hiddenProperties: [],
    calculations: [],
  },
};

/**
 * A cache holding the matter's properties, kept fresh so no read that is
 * enabled on its own refetches them, and nothing leaves the test.
 */
const warmClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(propertiesQueryRoot(WORKSPACE_ID), [
    {
      id: PROPERTY_ID,
      name: "Subject",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
      status: "fresh",
      kinds: null,
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
    },
  ]);
  return client;
};

/** `children` on a matter route under the member layout, with the app's intl. */
const renderInApp = async (children: ReactNode) => {
  const rootRoute = router.createRootRoute({ component: router.Outlet });
  const memberRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    id: "_protected",
    beforeLoad: () => ({ user }),
    component: router.Outlet,
  });
  const viewRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/workspaces/$workspaceId/$viewId",
    component: () => children,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({
      initialEntries: [`/workspaces/${WORKSPACE_ID}/view`],
    }),
    isServer: false,
    routeTree: rootRoute.addChildren([memberRoute.addChildren([viewRoute])]),
  });
  await appRouter.load();
  const rendered = testing.render(
    <QueryClientProvider client={warmClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              ...user,
              email: "member@example.test",
              image: null,
              name: "Fixture member",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <ActionCapabilitiesProvider
              value={resolveActionCapabilities({
                role: "member",
                ai: true,
                deepl: false,
                ocr: undefined,
                desktop: "none",
                settings: undefined,
              })}
            >
              <router.RouterProvider router={appRouter} />
            </ActionCapabilitiesProvider>
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await testing.waitFor(() => {
    expect(rendered.container.firstElementChild).not.toBeNull();
  });
  return rendered.container;
};

// The tokens that place and size a box; colour, state and focus styling may
// differ between a control and its face (a face reads as unavailable).
const BOX_TOKEN =
  /^(?:sm:)?(?:flex|inline-flex|items-center|border|rounded-\S+|gap-\S+|h-\S+|w-\S+|size-\S+|min-h-\S+|min-w-\S+|px-\S+|ps-\S+|pe-\S+|mx-\S+|text-xs)$/u;

/** What lays a box out, as one line. */
const boxOf = (box: Element) =>
  box.className
    .split(/\s+/u)
    .filter((token) => BOX_TOKEN.test(token))
    .toSorted()
    .join(" ");

const boxesOf = (boxes: Iterable<Element>) => [...boxes].map(boxOf);

const toolbarOf = (container: Element, slot: string) => {
  const toolbar = container.querySelector(`[data-slot="${slot}"]`);
  if (toolbar === null) {
    throw new Error(`no ${slot}`);
  }
  return toolbar;
};

const FOCUSABLE = "button, input, a, select, textarea, [tabindex]";

// What the loaded table toolbar adds after its always-present controls, for
// a member with AI: the playbook runner (behind that access) and "New
// column" (behind the matter's column count).
const TABLE_GATED_TAIL = 2;

const CASES: readonly { gatedTail: number; view: WorkspaceView }[] = [
  { view: boardView, gatedTail: 0 },
  { view: tableView, gatedTail: TABLE_GATED_TAIL },
];

for (const { gatedTail, view } of CASES) {
  test(`a ${view.layout.type} view's face lays out the loaded toolbar's controls, none of them usable`, async () => {
    const face = await renderInApp(
      <ViewToolbarChrome aria-hidden="true" data-slot="toolbar-face">
        <ViewToolbarFace view={view} />
      </ViewToolbarChrome>,
    );
    const faceRow = toolbarOf(face, "toolbar-face");
    expect(faceRow.querySelectorAll(FOCUSABLE).length).toBe(0);
    const faceBoxes = boxesOf(faceRow.children);
    // The controls inside a row's boxes: a select's trigger, a toggle's items.
    const faceSelects = boxesOf(
      faceRow.querySelectorAll('[data-slot="select-trigger-face"]'),
    );
    const faceToggleItems = boxesOf(
      faceRow.querySelectorAll('[data-slot="segmented-icon-toggle-face"] > *'),
    );
    // The table's group-by select and its two content modes; a board has none.
    expect([faceSelects.length, faceToggleItems.length]).toEqual(
      view.layout.type === "table" ? [1, 2] : [0, 0],
    );
    testing.cleanup();

    // Once the table's controls mount, the auth client reads the session; the
    // test hands the member to them directly, so that read finds none.
    const networkFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) =>
        String(args[0]).endsWith("/api/auth/get-session")
          ? Response.json(null)
          : networkFetch(...args),
      { preconnect: networkFetch.preconnect },
    );
    try {
      const live = await renderInApp(
        <ViewToolbar
          paneRef={{ current: null }}
          view={view}
          workspaceId={WORKSPACE_ID}
        />,
      );
      const liveRow = toolbarOf(live, "workspace-view-toolbar");
      const liveBoxes = boxesOf(liveRow.children);

      expect(liveBoxes.length).toBe(faceBoxes.length + gatedTail);
      expect(liveBoxes.slice(0, faceBoxes.length)).toEqual(faceBoxes);
      expect(
        boxesOf(liveRow.querySelectorAll('[data-slot="select-trigger"]')),
      ).toEqual(faceSelects);
      expect(
        boxesOf(liveRow.querySelectorAll('[data-slot="toggle-group-item"]')),
      ).toEqual(faceToggleItems);
    } finally {
      globalThis.fetch = networkFetch;
    }
  });
}
