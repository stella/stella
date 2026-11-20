import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { INSPECTOR_FOCUS_INTENT } from "@/components/inspector/inspector-store-types";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000" });
// Vite emits a URL for worker assets; the rail never starts the worker.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const { act, cleanup, fireEvent, render, waitFor } =
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
const { useInspectorTabsStore } = await import("./inspector-tabs-store");

afterEach(async () => {
  await act(async () => cleanup());
  useInspectorTabsStore.setState(useInspectorTabsStore.getInitialState(), true);
});
afterAll(unregisterDomEnvironment);

const openMarkdownTab = (resourcePath: string) => {
  useInspectorTabsStore.getState().openSkillResourceTab({
    skillName: "test-skill",
    skillId: "skill-1",
    origin: "authored",
    resourcePath,
    label: resourcePath,
    mimeType: "text/markdown",
    content: `# ${resourcePath}`,
    focus: INSPECTOR_FOCUS_INTENT.claim,
  });
};

// The rail as the panel wires it: activation goes through the store.
const activateTab = (tabId: string) => {
  const store = useInspectorTabsStore.getState();
  store.setActive(tabId);
  store.setMinimized(false);
};
const closeTab = (tabId: string) => {
  useInspectorTabsStore.getState().closeTab(tabId);
};
const setMinimized = (minimized: boolean) => {
  useInspectorTabsStore.getState().setMinimized(minimized);
};

const ConnectedRail = () => {
  const tabs = useInspectorTabsStore((s) => s.tabs);
  const activeId = useInspectorTabsStore((s) => s.activeId);
  const minimized = useInspectorTabsStore((s) => s.minimized);
  return (
    <InspectorRail
      activeId={activeId}
      minimized={minimized}
      onActivateTab={activateTab}
      onCloseTab={closeTab}
      onOpenChat={() => undefined}
      onSetMinimized={setMinimized}
      tabs={tabs}
    />
  );
};

const mountRail = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: ConnectedRail }),
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
              id: "rail-user",
              activeOrganizationId: "rail-org",
              email: "rail@example.test",
              image: null,
              name: "Rail tester",
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
  const tabButton = async (name: string) => {
    let button: HTMLElement | undefined;
    await waitFor(() => {
      button = view.getByRole("button", { name });
    });
    if (button === undefined) {
      throw new Error(`no rail tab named ${name}`);
    }
    return button;
  };
  return { client, tabButton, view };
};

// Every activation flash goes through `Element.animate`; the spy records the
// accessible name of each rail cell one landed on.
const spyOnFlashes = () => {
  const flashed: (string | null)[] = [];
  const spy = spyOn(HTMLElement.prototype, "animate").mockImplementation(
    function (this: HTMLElement) {
      flashed.push(this.getAttribute("aria-label"));
      return new Animation();
    },
  );
  return { flashed, spy };
};

test("clicking a rail tab activates it without flashing it", async () => {
  openMarkdownTab("notes/first.md");
  openMarkdownTab("notes/second.md");
  const { client, tabButton } = await mountRail();
  const { flashed, spy } = spyOnFlashes();
  try {
    const first = await tabButton("notes/first.md");
    const second = await tabButton("notes/second.md");
    // Back and forth, as a reader comparing two files does.
    for (const button of [first, second, first, second]) {
      await act(async () => {
        fireEvent.click(button);
      });
      expect(button.getAttribute("aria-current")).toBe("true");
    }
    // Re-clicking the tab that is already shown is still the reader's choice.
    await act(async () => {
      fireEvent.click(second);
    });
    expect(flashed).toEqual([]);
  } finally {
    spy.mockRestore();
    client.clear();
  }
});

test("an activation from outside the rail still flashes the tab it lands on", async () => {
  openMarkdownTab("notes/first.md");
  openMarkdownTab("notes/second.md");
  const { client, tabButton } = await mountRail();
  const { flashed, spy } = spyOnFlashes();
  try {
    const first = await tabButton("notes/first.md");
    // A rail click first, so the next activation follows a skipped one.
    await act(async () => {
      fireEvent.click(first);
    });
    expect(flashed).toEqual([]);

    // A document link or chat opening the other file.
    await act(async () => {
      openMarkdownTab("notes/second.md");
    });
    expect(flashed).toEqual(["notes/second.md"]);

    // And a programmatic switch back, with no click in between.
    const firstTab = useInspectorTabsStore
      .getState()
      .tabs.find((tab) => tab.label === "notes/first.md");
    if (firstTab === undefined) {
      throw new Error("first.md tab is not open");
    }
    await act(async () => {
      useInspectorTabsStore.getState().setActive(firstTab.id);
    });
    expect(flashed).toEqual(["notes/second.md", "notes/first.md"]);
  } finally {
    spy.mockRestore();
    client.clear();
  }
});
