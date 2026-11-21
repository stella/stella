import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { INSPECTOR_FOCUS_INTENT } from "@/components/inspector/inspector-store-types";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000" });
// Vite emits a URL for worker assets; neither the rail nor the switcher
// starts the worker.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { createRouteErrorLifecycleController } =
  await import("@/lib/analytics/route-error-lifecycle");
const { RouteErrorLifecycleProvider } =
  await import("@/lib/analytics/route-error-lifecycle-context");
const { InspectorRail } = await import("./inspector-rail");
const { useInspectorGroups } = await import("./inspector-group-controls");
const { InspectorTabSwitcherTrigger } =
  await import("./inspector-tab-header-frame");
const { InspectorTabSwitcherMenu } = await import("./inspector-tab-switcher");
const { useInspectorTabsStore } = await import("./inspector-tabs-store");

afterEach(async () => {
  await act(async () => cleanup());
  useInspectorTabsStore.setState(useInspectorTabsStore.getInitialState(), true);
});
afterAll(unregisterDomEnvironment);

const openMarkdownTab = (resourcePath: string) => {
  useInspectorTabsStore.getState().openSkillResourceTab({
    skillName: "engagement-skill",
    skillId: "skill-1",
    origin: "authored",
    resourcePath,
    label: resourcePath,
    mimeType: "text/markdown",
    content: `# ${resourcePath}`,
    focus: INSPECTOR_FOCUS_INTENT.claim,
  });
};

const tabIdLabelled = (label: string) => {
  const tab = useInspectorTabsStore
    .getState()
    .tabs.find((candidate) => candidate.label === label);
  if (tab === undefined) {
    throw new Error(`no open tab labelled ${label}`);
  }
  return tab.id;
};

const SKILL_TITLE = "NDA review";

/**
 * Tabs of several kinds, with a group whose tab was opened last: the store
 * lists tabs in opening order, the rail puts grouped tabs first, so a
 * switcher that read the store's order would disagree with the rail.
 */
const openMixedTabs = () => {
  openMarkdownTab("notes/engagement-terms.md");
  useInspectorTabsStore.getState().openChat({
    focus: INSPECTOR_FOCUS_INTENT.claim,
  });
  // An untitled chat is shown under its skill's title, not its stored
  // placeholder.
  useInspectorTabsStore.getState().openChat({
    activeSkill: {
      skillId: "skill-nda",
      skillName: "nda-review",
      skillDisplayName: SKILL_TITLE,
    },
    focus: INSPECTOR_FOCUS_INTENT.claim,
  });
  useInspectorTabsStore.getState().openMatter({
    workspaceId: "matter-1",
    label: "Meridian supply agreement",
    color: null,
  });
  openMarkdownTab("notes/closing-checklist.md");
  const store = useInspectorTabsStore.getState();
  const groupId = store.createGroup({
    name: "Closing set",
    color: "#59a1d4",
  });
  store.setTabGroup(tabIdLabelled("notes/closing-checklist.md"), groupId);
};

// The rail as the panel wires it: activation goes through the store.
const activateTab = (tabId: string) => {
  const store = useInspectorTabsStore.getState();
  store.setActive(tabId);
  store.setMinimized(false);
};

const RailAndSwitcher = () => {
  const tabs = useInspectorTabsStore((s) => s.tabs);
  const activeId = useInspectorTabsStore((s) => s.activeId);
  const minimized = useInspectorTabsStore((s) => s.minimized);
  // One read for both, as the panel does.
  const groups = useInspectorGroups();
  return (
    <>
      <InspectorRail
        activeId={activeId}
        groups={groups}
        minimized={minimized}
        onActivateTab={activateTab}
        onCloseTab={(tabId) => useInspectorTabsStore.getState().closeTab(tabId)}
        onOpenChat={() => undefined}
        onSetMinimized={(next) =>
          useInspectorTabsStore.getState().setMinimized(next)
        }
        tabs={tabs}
      />
      <header data-testid="phone-header">
        <InspectorTabSwitcherTrigger />
      </header>
      <InspectorTabSwitcherMenu groups={groups} />
    </>
  );
};

// A rail tab is the one draggable cell per open tab; the tooltip it carries
// takes over its data-slot.
const RAIL_TAB = 'button[draggable="true"]';

const mount = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: RailAndSwitcher }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const lifecycle = createRouteErrorLifecycleController({
    captureError: () => undefined,
    captureRouteErrorLifecycle: async () => undefined,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              id: "switcher-user",
              activeOrganizationId: "switcher-org",
              email: "switcher@example.test",
              image: null,
              name: "Switcher tester",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <RouteErrorLifecycleProvider controller={lifecycle}>
              <TooltipProvider>
                <RouterProvider router={router} />
              </TooltipProvider>
            </RouteErrorLifecycleProvider>
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => {
    if (view.container.querySelector(RAIL_TAB)) {
      return;
    }
    throw new Error("the rail has not rendered its tabs");
  });
  return { client, view };
};

/** The rail's tabs, top to bottom, by accessible name. */
const railTabs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(RAIL_TAB)].map(
    (tab) => tab.getAttribute("aria-label") ?? "",
  );

const openSwitcher = async (
  view: Awaited<ReturnType<typeof mount>>["view"],
) => {
  const count = useInspectorTabsStore.getState().tabs.length;
  const trigger = within(view.getByTestId("phone-header")).getByRole("button", {
    name: messages.inspector.openTabs.replace("{count, number}", () =>
      String(count),
    ),
  });
  await act(async () => {
    fireEvent.click(trigger);
  });
  return await view.findByRole("menu");
};

const switcherItems = (menu: HTMLElement) =>
  within(menu).getAllByRole("menuitemradio");

/** An item's label: its text without the check mark's title. */
const itemLabel = (item: HTMLElement) => {
  const copy = item.cloneNode(true);
  if (!(copy instanceof HTMLElement)) {
    throw new TypeError("a menu item clones to an element");
  }
  for (const icon of copy.querySelectorAll("svg")) {
    icon.remove();
  }
  return copy.textContent.trim();
};

test("the phone switcher lists the rail's tabs, in the rail's order, under the same labels", async () => {
  openMixedTabs();
  const { client, view } = await mount();
  try {
    const rail = railTabs(view.container);
    // The fixture reaches the fault: the rail's order is not opening order.
    expect(rail).not.toEqual(
      useInspectorTabsStore.getState().tabs.map((tab) => tab.label),
    );
    // And a label a tab resolves differs from the one it stores.
    expect(rail).toContain(SKILL_TITLE);
    expect(
      useInspectorTabsStore.getState().tabs.map((tab) => tab.label),
    ).not.toContain(SKILL_TITLE);

    const menu = await openSwitcher(view);
    expect(switcherItems(menu).map(itemLabel)).toEqual(rail);
    expect(within(menu).getByText("Closing set")).not.toBeNull();
  } finally {
    client.clear();
  }
});

test("each tab shows the rail's icon in the switcher", async () => {
  openMixedTabs();
  const { client, view } = await mount();
  try {
    for (const tab of useInspectorTabsStore.getState().tabs) {
      await act(async () => activateTab(tab.id));
      // The rail draws the full icon only on the active tab.
      const railIcon = view.container.querySelector(
        `${RAIL_TAB}[aria-current="true"] svg`,
      )?.outerHTML;
      const menu = await openSwitcher(view);
      const checked = switcherItems(menu).find(
        (item) => item.getAttribute("aria-checked") === "true",
      );
      // The item's first svg is the check mark; the tab's icon follows it.
      const switcherIcon = checked?.querySelectorAll("svg")[1]?.outerHTML;
      expect(railIcon).toBeDefined();
      expect(switcherIcon).toBe(railIcon);
      await act(async () => {
        fireEvent.keyDown(menu, { key: "Escape" });
      });
    }
  } finally {
    client.clear();
  }
});

test("picking a tab in the switcher shows that tab", async () => {
  openMixedTabs();
  const engagementTerms = tabIdLabelled("notes/engagement-terms.md");
  const { client, view } = await mount();
  try {
    expect(useInspectorTabsStore.getState().activeId).not.toBe(engagementTerms);
    const menu = await openSwitcher(view);
    await act(async () => {
      fireEvent.click(
        within(menu).getByRole("menuitemradio", {
          name: "notes/engagement-terms.md",
        }),
      );
    });
    expect(useInspectorTabsStore.getState().activeId).toBe(engagementTerms);
    expect(useInspectorTabsStore.getState().minimized).toBe(false);
    await waitFor(() => {
      expect(view.queryByRole("menu") === null).toBe(true);
    });
    const reopened = await openSwitcher(view);
    expect(
      within(reopened)
        .getByRole("menuitemradio", { name: "notes/engagement-terms.md" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  } finally {
    client.clear();
  }
});
