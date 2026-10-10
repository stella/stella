import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EventType } from "@tanstack/ai";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { WebApiRoutes } from "@/lib/eden-client";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
// Match Vite's worker asset import without replacing the page or its runtime.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const previousFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: previousFetch.preconnect,
});
const requests: Request[] = [];
const sends: unknown[] = [];
const unexpected: string[] = [];

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { AIAvailabilityProvider } = await import("@/components/require-ai-key");
const { roleOptions } = await import("@/lib/auth-queries");
const { useChatDraftStore } = await import("@/lib/chat-draft-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { __resetChatRequestStateForTests, chatThreadOptions } =
  await import("@/features/chat/queries");
const { setThreadActiveSkill, useThreadActiveSkillStore } =
  await import("@/features/chat/thread-active-skill-store");
const { ChatThreadPage } = await import("./chat-thread-page");

const user = {
  activeOrganizationId: "00000000-0000-7000-8000-00000000ffff",
  id: "00000000-0000-7000-8000-00000000fffe",
  email: "reader@example.test",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const threadRef = {
  scope: "global",
  threadId: toChatThreadId("00000000-0000-7000-8000-00000000c0de"),
} as const;
const builder = { skillName: "playbook-builder" };

type ThreadResponse =
  WebApiRoutes["chat"]["threads"][":threadId"]["messages"]["get"]["response"][200];
const savedThread = {
  activeSkill: builder,
  activeTurnId: null,
  attachedFiles: { fileCount: 0, files: [] },
  context: null,
  contextMatterIds: [],
  forkProvenance: { type: "none" },
  lastActivityAt: null,
  messages: [],
  model: null,
  olderCursor: null,
  reasoningEffort: null,
  threadExists: true,
  threadRevision: "2026-10-10T12:00:00.000Z",
  usedAnonymization: false,
  webSearchAvailable: false,
  webSearchEnabled: false,
} satisfies ThreadResponse;
const clients: InstanceType<typeof query.QueryClient>[] = [];

afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  __resetChatRequestStateForTests();
  useThreadActiveSkillStore.setState({ skills: {} });
  useChatDraftStore.setState({ draftsByThreadKey: {} });
  globalThis.fetch = previousFetch;
  requests.length = 0;
  sends.length = 0;
  unexpected.length = 0;
});
afterAll(async () => {
  // Drain scheduled React work before removing the DOM.
  await testing.act(async () => {
    await sleep(50);
  });
  await GlobalRegistrator.unregister();
});

test("reopening an evicted builder on the thread page restores its skill for the next send", async () => {
  setThreadActiveSkill(threadRef, builder);
  for (let index = 0; index < 51; index += 1) {
    setThreadActiveSkill(
      { scope: "global", threadId: toChatThreadId(`newer-${index}`) },
      builder,
    );
  }
  expect(
    useThreadActiveSkillStore.getState().skills[getChatThreadKey(threadRef)],
  ).toBeUndefined();

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.endsWith(`/chat/threads/${threadRef.threadId}/messages`)) {
        requests.push(request);
        return Response.json(savedThread);
      }
      if (pathname.endsWith("/chat") && request.method === "POST") {
        const body: unknown = await request.json();
        sends.push(body);
        if (
          typeof body !== "object" ||
          body === null ||
          !("runId" in body) ||
          typeof body.runId !== "string"
        ) {
          throw new TypeError("Expected the page to send a chat runId");
        }
        const events = [
          {
            type: EventType.RUN_STARTED,
            runId: body.runId,
            threadId: threadRef.threadId,
            timestamp: 1_791_633_600_000,
          },
          {
            type: EventType.RUN_FINISHED,
            runId: body.runId,
            threadId: threadRef.threadId,
            timestamp: 1_791_633_600_000,
            finishReason: "stop",
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (pathname.endsWith("/organization-settings/ai-availability")) {
        return Response.json({ available: true });
      }
      if (pathname.endsWith("/skills")) {
        return Response.json({
          installed: [],
          builtIn: [],
          nextCursor: null,
        } satisfies WebApiRoutes["skills"]["get"]["response"][200]);
      }
      if (pathname.endsWith("/mcp/connectors")) {
        return Response.json({
          canManageCustomConnectors: false,
          connectors: [],
          nativeTools: [],
        });
      }
      if (pathname.endsWith("/chat/skill-availability")) {
        return Response.json({ unavailable: [] });
      }
      if (pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      unexpected.push(pathname);
      return Response.json(
        { message: `Unexpected page test request: ${pathname}` },
        { status: 500 },
      );
    },
    { preconnect: previousFetch.preconnect },
  );

  const client = new query.QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "member");
  client.setQueryData(
    workspacesNavigationOptions({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }).queryKey,
    { workspaces: [], features: { timeBilling: false } },
  );
  useChatDraftStore
    .getState()
    .insertInlineContent(getChatThreadKey(threadRef), [
      { type: "text", text: "Continue building the playbook" },
    ]);

  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user }),
    component: router.Outlet,
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/chat/$threadId",
    component: () => (
      <ChatEditorProvider>
        <ChatThreadPage threadRef={threadRef} />
      </ChatEditorProvider>
    ),
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
    history: router.createMemoryHistory({
      initialEntries: [`/chat/${threadRef.threadId}`],
    }),
    isServer: false,
  });
  await appRouter.load();
  const ui = testing.render(
    <AnalyticsContext value={noopAnalytics}>
      <query.QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider user={user}>
              <AIAvailabilityProvider>
                <router.RouterProvider router={appRouter} />
              </AIAvailabilityProvider>
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </query.QueryClientProvider>
    </AnalyticsContext>,
  );
  await testing.waitFor(() =>
    expect(
      ui
        .getByRole("button", { name: messages.chat.sendPrompt })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  const plainQuery = chatThreadOptions({
    activeOrganizationId: user.activeOrganizationId,
    key: threadRef,
    context: { allowMissingThread: true },
  });
  expect(client.getQueryData(plainQuery.queryKey)).toMatchObject({
    activeSkill: builder,
    threadExists: true,
  });
  expect(requests).toHaveLength(1);
  expect(
    useThreadActiveSkillStore.getState().skills[getChatThreadKey(threadRef)],
  ).toBeUndefined();

  await testing.act(async () => {
    testing.fireEvent.click(
      ui.getByRole("button", { name: messages.chat.sendPrompt }),
    );
    await testing.waitFor(() => {
      expect(unexpected).toEqual([]);
      expect(sends).toHaveLength(1);
    });
  });
  expect(sends.at(0)).toMatchObject({
    forwardedProps: { activeSkill: builder, threadId: threadRef.threadId },
  });
  expect(unexpected).toEqual([]);
});
