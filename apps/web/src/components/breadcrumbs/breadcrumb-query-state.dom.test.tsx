import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import type { ChatThreadFetched } from "@/features/chat/queries";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { contactOptions } = await import("@/lib/contacts/queries");
const { workspaceOptions } = await import("@/lib/workspaces/queries");
const { skillDetailOptions } = await import("@/lib/knowledge/queries");
const { fileMetadataOptions } = await import("@/lib/files/file-metadata-query");
const {
  groupedChatThreadsOptions,
  chatThreadOptions,
  chatThreadTitleOptions,
  mergeGroupedChatThreadPages,
} = await import("@/features/chat/queries");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { ContactBreadcrumb } = await import("./contact-breadcrumb");
const { WorkspaceBreadcrumb } = await import("./workspace-breadcrumb");
const { SkillBreadcrumb } = await import("./skill-breadcrumb");
const { PdfBreadcrumb } = await import("./pdf-breadcrumb");
const { FileChatTitleSlot } =
  await import("@/components/ai-suggestions/file-chat-title-slot");
const { ChatBreadcrumb } = await import("./chat-breadcrumb");
const messages = (await import("@/i18n/langs/en.json")).default;
const user = {
  activeOrganizationId: "organization",
  id: "user",
  email: "test@example.test",
  name: "Test",
  image: null,
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await sleep(0);
  await GlobalRegistrator.unregister();
});

const groupedKey = groupedChatThreadsOptions({
  activeOrganizationId: user.activeOrganizationId,
  userId: user.id,
}).queryKey;
const threadKey = chatThreadOptions({
  activeOrganizationId: user.activeOrganizationId,
  key: { scope: "global", threadId: toChatThreadId("thread") },
  context: { allowMissingThread: true },
}).queryKey;
const emptyGroupPages = [
  { global: [], workspaces: [], nextCursor: null },
] satisfies Parameters<typeof mergeGroupedChatThreadPages>[0];
const persistedThread = {
  activeTurnId: null,
  attachedFiles: { fileCount: 0, files: [] },
  forkProvenance: { type: "none" },
  messages: [],
  olderCursor: null,
  contextMatterIds: [],
  lastActivityAt: null,
  threadRevision: null,
  threadExists: true,
  usedAnonymization: false,
  webSearchAvailable: false,
  webSearchEnabled: false,
  context: null,
  model: null,
  reasoningEffort: null,
} satisfies ChatThreadFetched;
const seedGroupedMiss = (client: InstanceType<typeof QueryClient>) => {
  client.setQueryData(groupedKey, {
    pages: emptyGroupPages,
    pageParams: [undefined],
  });
};
const seedPersistedThread = (client: InstanceType<typeof QueryClient>) => {
  seedGroupedMiss(client);
  client.setQueryData(threadKey, persistedThread);
};

const cases = [
  {
    name: "contact",
    path: "/contacts/$contactId",
    url: "/contacts/contact",
    key: contactOptions(user.activeOrganizationId, "contact").queryKey,
    component: () => <ContactBreadcrumb contactId="contact" />,
  },
  {
    name: "matter",
    path: "/workspaces/$workspaceId/",
    url: "/workspaces/matter",
    key: workspaceOptions("matter").queryKey,
    component: () => <WorkspaceBreadcrumb workspaceId="matter" />,
  },
  {
    name: "skill",
    path: "/knowledge/tools_/$entry",
    url: "/knowledge/tools_/11111111-1111-4111-8111-111111111111",
    key: skillDetailOptions(
      user.activeOrganizationId,
      user.id,
      "11111111-1111-4111-8111-111111111111",
    ).queryKey,
    component: SkillBreadcrumb,
  },
  {
    name: "document",
    path: "/workspaces/$workspaceId/$viewId/document",
    url: "/workspaces/matter/view/document?field=file&entity=document",
    key: fileMetadataOptions({ workspaceId: "matter", fieldId: "file" })
      .queryKey,
    component: PdfBreadcrumb,
  },
  {
    name: "chat",
    path: "/chat/$threadId",
    url: "/chat/thread",
    key: groupedChatThreadsOptions({
      activeOrganizationId: user.activeOrganizationId,
      userId: user.id,
    }).queryKey,
    component: () => <ChatBreadcrumb threadId="thread" />,
  },
  {
    name: "chat existence",
    path: "/chat/$threadId",
    url: "/chat/thread",
    key: threadKey,
    component: () => <ChatBreadcrumb threadId="thread" />,
    seed: seedGroupedMiss,
  },
  {
    name: "chat title",
    path: "/chat/$threadId",
    url: "/chat/thread",
    key: chatThreadTitleOptions({
      activeOrganizationId: user.activeOrganizationId,
      enabled: true,
      key: { threadId: "thread" },
    }).queryKey,
    component: () => <ChatBreadcrumb threadId="thread" />,
    seed: seedPersistedThread,
  },
  {
    name: "file chat title",
    path: "/file-chat",
    url: "/file-chat",
    key: chatThreadTitleOptions({
      activeOrganizationId: user.activeOrganizationId,
      enabled: true,
      key: { threadId: "thread" },
    }).queryKey,
    component: () => (
      <FileChatTitleSlot
        activeOrganizationId={user.activeOrganizationId}
        hasMessages
        threadRef={{ scope: "global", threadId: toChatThreadId("thread") }}
        usedAnonymization={false}
      />
    ),
  },
] as const;

for (const scenario of cases) {
  test(`${scenario.name} breadcrumb read failure shows retry instead of a fallback name`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    clients.push(client);
    if ("seed" in scenario) {
      scenario.seed(client);
    }
    client
      .getQueryCache()
      .build(client, { queryKey: scenario.key })
      .setState({
        status: "error",
        fetchStatus: "idle",
        error: new Error("Name unavailable"),
        data: undefined,
      });
    const root = router.createRootRoute({ component: router.Outlet });
    const protectedRoute = router.createRoute({
      getParentRoute: () => root,
      id: "_protected",
      component: router.Outlet,
    });
    const route = router.createRoute({
      getParentRoute: () => (scenario.name === "skill" ? root : protectedRoute),
      path: scenario.path,
      component: scenario.component,
      validateSearch: (search) => search,
    });
    const tree =
      scenario.name === "skill"
        ? root.addChildren([route])
        : root.addChildren([protectedRoute.addChildren([route])]);
    const appRouter = router.createRouter({
      history: router.createMemoryHistory({ initialEntries: [scenario.url] }),
      routeTree: tree,
      isServer: false,
    });
    await appRouter.load();
    const ui = render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages}>
          <AuthenticatedUserProvider user={user}>
            <router.RouterProvider router={appRouter} />
          </AuthenticatedUserProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(ui.getByRole("alert").textContent).toContain(
        messages.common.somethingWentWrong,
      ),
    );
    expect(
      ui.getByRole("button", { name: messages.common.retry }),
    ).toBeDefined();
    expect(ui.queryByRole("link")).toBeNull();
    expect(ui.queryByRole("textbox")).toBeNull();
  });
}
