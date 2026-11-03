import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { InspectorTab } from "./inspector-store-types";

GlobalRegistrator.register({ url: "http://localhost:3000/panel-fixture" });
Object.assign(import.meta.env, { DEV: true });
Bun.plugin({
  name: "panel-route-worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { getByRole } = await import("@testing-library/dom");
const { QueryClient, QueryClientProvider, onlineManager } =
  await import("@tanstack/react-query");
const {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { bundledEnglishMessages } = await import("@/i18n/i18n-store");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AIAvailabilityProvider } = await import("@/components/require-ai-key");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { RouteErrorLifecycleProvider } =
  await import("@/lib/analytics/route-error-lifecycle-context");
const { createRouteErrorLifecycleController } =
  await import("@/lib/analytics/route-error-lifecycle");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { RouteProviderScopeBoundary } =
  await import("@/components/route-provider-scope/route-provider-scope");
const { MEMBER_PROVIDER_SCOPES } = await import("@/routes/-app-frame-scope");
const { InspectorPanel } = await import("./inspector-panel");
const { BUILT_IN_KINDS } = await import("./view-registry-builtins");
const { getInspectorViews } = await import("./view-registry");
const { genericPanelFixtures, warmPanelViewRenderers } =
  await import("@/__fixtures__/panel-tab-view-fixtures");
const { knowledgePanelFixtures, warmKnowledgePanelViewRenderers } =
  await import("@/routes/knowledge/-components/__fixtures__/panel-tab-view-fixtures");
const { useInspectorTabsStore } = await import("./inspector-tabs-store");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");

const user = {
  activeOrganizationId: "panel-organization",
  email: "panel@example.test",
  id: "panel-reader",
  image: null,
  name: "Panel reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const workspaceId = "panel-matter";
const builtinFixtures = {
  task: {
    type: "task",
    id: "panel-task",
    label: "Task",
    workspaceId,
    creationStatus: "pending",
    isNew: false,
  },
  pdf: {
    type: "pdf",
    id: "panel-document",
    entityId: "panel-entity",
    label: "Document",
    fileName: "exhibit.pdf",
    mimeType: "application/pdf",
    pdfFileId: null,
    workspaceId,
    facet: "preview",
  },
  chat: {
    type: "chat",
    id: toChatThreadId("00000000-0000-4000-8000-000000000009"),
    label: "Chat",
    contextMatterIds: [],
  },
  matter: {
    type: "matter",
    id: "matter:panel-matter",
    label: "Matter",
    workspaceId,
  },
  external: {
    type: "external",
    id: "external:panel-source",
    chatThreadId: toChatThreadId("00000000-0000-4000-8000-000000000010"),
    label: "Source",
    url: "https://example.test/reference",
    workspaceId: null,
  },
  "skill-resource": {
    type: "skill-resource",
    id: "skill-resource:panel:notes.txt",
    label: "notes.txt",
    skillName: "panel",
    origin: "built-in",
    skillId: null,
    target: "resource",
    resourcePath: "notes.txt",
    mimeType: "text/plain",
    content: "Panel resource content",
  },
} as const satisfies {
  [Kind in Exclude<InspectorTab["type"], "view">]: Extract<
    InspectorTab,
    { type: Kind }
  >;
};

await Promise.all([
  warmPanelViewRenderers(),
  warmKnowledgePanelViewRenderers(),
]);

const originalOnline = onlineManager.isOnline();
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const client of clients) {
      await client.cancelQueries();
      client.clear();
    }
  });
  clients.length = 0;
  useInspectorTabsStore.setState({
    tabs: [],
    activeId: null,
    minimized: false,
  });
});
afterAll(async () => {
  onlineManager.setOnline(originalOnline);
  await unregisterDomEnvironment();
});

// Route contracts are the source of truth: every route family that may host
// signed-in providers is exercised, even when it also serves visitors.
const routeRoot = new URL("../../routes/", import.meta.url);
const families: string[] = [];
for (const path of new Bun.Glob("**/*.tsx").scanSync({
  cwd: routeRoot.pathname,
})) {
  if (
    path.includes(".test.") ||
    path.split("/").some((part) => part.startsWith("-"))
  ) {
    continue;
  }
  const source = await Bun.file(new URL(path, routeRoot)).text();
  if (!/providerScopes:\s*MEMBER_PROVIDER_SCOPES/u.test(source)) {
    continue;
  }
  const id = /createFileRoute\("([^"]+)"\)/u.exec(source)?.[1];
  expect(id).toBeDefined();
  if (id !== undefined) {
    families.push(id);
  }
}
expect(families).toEqual(
  expect.arrayContaining(["/_protected", "/knowledge", "/law", "/tools"]),
);

const sourceRoot = new URL("../../", import.meta.url);
const registrationPaths = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: sourceRoot.pathname }),
].filter(
  (path) =>
    !path.includes(".test.") &&
    !path.split("/").includes("__fixtures__") &&
    path !== "components/inspector/view-registry.ts",
);
const registrationSources = await Promise.all(
  registrationPaths.map(async (path) => ({
    path,
    source: await Bun.file(new URL(path, sourceRoot)).text(),
  })),
);
await Promise.all(
  registrationSources
    .filter(({ source }) => /\bregisterInspectorView\s*(?:<|\()/u.test(source))
    .map(async ({ path }) => import(new URL(path, sourceRoot).pathname)),
);

const panelFixtures = [
  ...BUILT_IN_KINDS.map((kind) => builtinFixtures[kind]),
  ...genericPanelFixtures,
  ...knowledgePanelFixtures,
];
expect(
  getInspectorViews()
    .map(({ type }) => type)
    .toSorted(),
).toEqual(
  [
    ...BUILT_IN_KINDS,
    ...genericPanelFixtures.map(({ viewType }) => viewType),
    ...knowledgePanelFixtures.map(({ viewType }) => viewType),
  ].toSorted(),
);
for (const tab of [...genericPanelFixtures, ...knowledgePanelFixtures]) {
  expect(
    getInspectorViews()
      .find(({ type }) => type === tab.viewType)
      ?.validate(tab.payload),
    tab.viewType,
  ).toBe(true);
}

for (const family of families) {
  for (const tab of panelFixtures) {
    test(`${family}: ${tab.type === "view" ? tab.viewType : tab.type} panel renders outside sibling route contexts`, async () => {
      // Pause external queries: every tab must compose with the shared
      // providers before its data arrives, independently of the active route.
      onlineManager.setOnline(false);
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity },
          mutations: { retry: false },
        },
      });
      clients.push(client);
      useInspectorTabsStore.setState({
        tabs: [tab],
        activeId: tab.id,
        minimized: false,
      });
      const caught: unknown[] = [];
      const root = createRootRoute();
      const parent = createRoute({
        getParentRoute: () => root,
        id: family.replace(/^\//u, ""),
        staticData: { providerScopes: MEMBER_PROVIDER_SCOPES },
        beforeLoad: () => ({ user }),
      });
      const leaf = createRoute({
        getParentRoute: () => parent,
        path: "panel-fixture",
        component: () => (
          <RouteProviderScopeBoundary>
            <RouteErrorLifecycleProvider
              controller={createRouteErrorLifecycleController(noopAnalytics)}
            >
              <IntlProvider
                locale="en"
                messages={bundledEnglishMessages}
                timeZone="UTC"
              >
                <FormattingProvider locale="en" timeZone="UTC">
                  <AuthenticatedUserProvider user={user}>
                    <AIAvailabilityProvider>
                      <ChatEditorProvider>
                        <InspectorPanel />
                      </ChatEditorProvider>
                    </AIAvailabilityProvider>
                  </AuthenticatedUserProvider>
                </FormattingProvider>
              </IntlProvider>
            </RouteErrorLifecycleProvider>
          </RouteProviderScopeBoundary>
        ),
      });
      const router = createRouter({
        routeTree: root.addChildren([parent.addChildren([leaf])]),
        history: createMemoryHistory({ initialEntries: ["/panel-fixture"] }),
        defaultOnCatch: (error) => {
          caught.push(error);
        },
      });
      await router.load();
      const mounted = await act(async () =>
        render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
          {
            onCaughtError: (error) => {
              caught.push(error);
            },
          },
        ),
      );
      await waitFor(() => {
        expect(caught).toEqual([]);
        const inspector = mounted.container.querySelector(
          '[data-slot="inspector"]',
        );
        expect(inspector).not.toBeNull();
        // The rail is the first child. A tab body or its own pending shell
        // must also mount; an empty dispatch is not a successful render.
        expect(inspector?.children.length).toBeGreaterThan(1);
      });
      expect(useInspectorTabsStore.getState().activeId).toBe(tab.id);
      if (tab.type === "task") {
        expect(
          mounted.container.querySelectorAll('[data-slot="skeleton"]').length,
        ).toBeGreaterThan(0);
        expect(
          getByRole(mounted.container, "button", {
            name: bundledEnglishMessages.common.close,
          }),
        ).toBeDefined();
      }
      if (tab.type === "skill-resource") {
        expect(mounted.container.textContent).toContain(tab.content);
      }
    });
  }
}
