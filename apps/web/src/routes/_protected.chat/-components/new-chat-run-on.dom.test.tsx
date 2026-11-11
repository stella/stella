import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EventType } from "@tanstack/ai";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import {
  type ChatLocalRunReadiness,
  type ChatLocalRunTarget,
  chatRunTargetSchema,
} from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { aiAvailableResponse } from "@/__fixtures__/ai-availability";
import type { WebApiRoutes } from "@/lib/api";

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

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
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
const { rememberRunTarget, useChatRunOnPreferenceStore } =
  await import("@/features/chat/run-on-preference-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/chat-runtime-registry");
const { Route: ChatIndexRoute } = await import("../index");

const user = {
  activeOrganizationId: "00000000-0000-7000-8000-00000000ffff",
  id: "00000000-0000-7000-8000-00000000fffe",
  email: "member@example.test",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const CODEX: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
};

/** One connected computer whose Codex is ready. */
const READINESS: ChatLocalRunReadiness = {
  status: "enabled",
  runners: [
    {
      desktopId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
      connected: true,
      lastSeenAt: "2026-11-03T10:00:00.000Z",
      harnesses: [
        {
          id: "codex",
          state: "ready",
          version: "0.50.0",
          capabilities: ["approvals"],
          approvalModes: ["ask"],
          models: [{ id: CODEX.model, label: "GPT-5 Codex" }],
        },
      ],
    },
  ],
  maxApprovals: "full_auto",
};

/** The same computer, not connected now: its last report still names Codex. */
const OFFLINE: ChatLocalRunReadiness = {
  ...READINESS,
  runners: READINESS.runners.map((runner) => ({ ...runner, connected: false })),
};

type ThreadResponse =
  WebApiRoutes["chat"]["threads"][":threadId"]["messages"]["get"]["response"][200];

/** A thread nobody has written to yet, as the server reads a new chat's draft. */
const draftThread = (runTarget: ChatLocalRunTarget | null): ThreadResponse => ({
  activeSkill: null,
  activeTurnId: null,
  newestLocalTurn: null,
  attachedFiles: { fileCount: 0, files: [] },
  context: {
    estimatedTokens: 0,
    triggerTokens: 0,
    cacheStableTokens: 0,
    summarizedMessageCount: 0,
    breakdown: {
      promptTokens: 0,
      toolTokens: 0,
      summaryTokens: 0,
      attachmentTokens: 0,
      conversationTokens: 0,
    },
  },
  contextMatterIds: [],
  forkProvenance: { type: "none" },
  lastActivityAt: null,
  messages: [],
  model: null,
  olderCursor: null,
  reasoningEffort: null,
  ...(runTarget === null ? {} : { runTarget }),
  threadExists: runTarget !== null,
  threadRevision: "2026-10-10T12:00:00.000Z",
  usedAnonymization: false,
  webSearchAvailable: false,
  webSearchEnabled: false,
});

const ANSWER = "Done on your computer.";

/**
 * The server: the draft's row stores what the model menu PATCHes, every read
 * of the thread returns it, and a send answers with one short turn.
 */
const serve = (readiness: ChatLocalRunReadiness = READINESS) => {
  const state = {
    stored: null as ChatLocalRunTarget | null,
    threadIds: new Set<string>(),
    patches: [] as unknown[],
    sends: [] as unknown[],
    unexpected: [] as string[],
  };
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      const read = /\/chat\/threads\/([^/]+)\/messages$/u.exec(pathname);
      if (read?.[1] !== undefined) {
        state.threadIds.add(read[1]);
        return Response.json(draftThread(state.stored));
      }
      if (
        /\/chat\/threads\/[^/]+\/model$/u.test(pathname) &&
        request.method === "PATCH"
      ) {
        const body: unknown = await request.json();
        state.patches.push(body);
        const patch = v.safeParse(
          v.object({ runTarget: v.optional(chatRunTargetSchema) }),
          body,
        );
        if (!patch.success) {
          throw new TypeError("Expected the page to PATCH a run target");
        }
        if (patch.output.runTarget !== undefined) {
          state.stored =
            patch.output.runTarget.kind === "local"
              ? patch.output.runTarget
              : null;
        }
        return Response.json(body);
      }
      if (pathname.endsWith("/chat/local-runners")) {
        return Response.json(readiness);
      }
      if (pathname.endsWith("/chat") && request.method === "POST") {
        const body: unknown = await request.json();
        state.sends.push(body);
        const runId =
          typeof body === "object" &&
          body !== null &&
          "runId" in body &&
          typeof body.runId === "string"
            ? body.runId
            : "run";
        const threadId =
          typeof body === "object" &&
          body !== null &&
          "threadId" in body &&
          typeof body.threadId === "string"
            ? body.threadId
            : "thread";
        const at = 1_791_633_600_000;
        const events = [
          { type: EventType.RUN_STARTED, runId, threadId, timestamp: at },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "answer-1",
            role: "assistant",
            timestamp: at,
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer-1",
            delta: ANSWER,
            timestamp: at,
          },
          {
            type: EventType.TEXT_MESSAGE_END,
            messageId: "answer-1",
            timestamp: at,
          },
          {
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            timestamp: at,
            finishReason: "stop",
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      // The page's own reads around the composer: no chats, skills or models
      // of stella's that this test picks.
      if (pathname.endsWith("/chat/threads") && request.method === "GET") {
        return Response.json({
          global: [],
          nextCursor: null,
          workspaces: [],
        } satisfies WebApiRoutes["chat"]["threads"]["get"]["response"][200]);
      }
      if (pathname.endsWith("/skills")) {
        return Response.json({
          builtIn: [],
          installed: [],
          canManageTeam: false,
          limit: 100,
          nextCursor: null,
        } satisfies WebApiRoutes["skills"]["get"]["response"][200]);
      }
      if (pathname.endsWith("/chat/skill-availability")) {
        return Response.json({ unavailable: [] });
      }
      if (pathname.endsWith("/chat/model-options")) {
        return Response.json({
          options: [],
          defaultValue: null,
          benchmarkOptions: [],
          benchmarkMetadata: {
            benchmarkName: "",
            licence: "",
            publishDate: "",
            sourceUrl: "",
            typicalCallInputTokens: 0,
            typicalCallOutputTokens: 0,
          },
        } satisfies WebApiRoutes["chat"]["model-options"]["get"]["response"][200]);
      }
      if (pathname.endsWith("/organization-settings/ai-availability")) {
        return Response.json(aiAvailableResponse());
      }
      if (pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      state.unexpected.push(`${request.method} ${pathname}`);
      return Response.json(
        { message: `Unexpected page test request: ${pathname}` },
        { status: 500 },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
  return state;
};

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  __resetChatRequestStateForTests();
  useChatDraftStore.setState({ draftsByThreadKey: {} });
  useChatRunOnPreferenceStore.setState({ byOrganization: {} });
  globalThis.fetch = previousFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const createClient = () => {
  const client = new QueryClient({
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
  return client;
};

/** The new-chat page, with the thread route the first send moves to. */
const openNewChat = async (client: InstanceType<typeof QueryClient>) => {
  const NewChat = ChatIndexRoute.options.component;
  if (NewChat === undefined) {
    throw new Error("The new-chat route renders no component");
  }
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user }),
    component: router.Outlet,
  });
  const index = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/chat",
    component: () => (
      <ChatEditorProvider>
        <NewChat />
      </ChatEditorProvider>
    ),
  });
  const thread = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/chat/$threadId",
    component: () => null,
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([index, thread])]),
    history: router.createMemoryHistory({ initialEntries: ["/chat"] }),
    isServer: false,
  });
  await appRouter.load();
  const ui = testing.render(
    <AnalyticsContext value={noopAnalytics}>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider user={user}>
              <AIAvailabilityProvider>
                <router.RouterProvider router={appRouter} />
              </AIAvailabilityProvider>
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </AnalyticsContext>,
  );
  await ui.findByRole("textbox");
  return { ui, appRouter };
};

/** Write into the new chat's composer, whose thread id the page chose. */
const typeDraft = (server: ReturnType<typeof serve>, text: string) => {
  const [threadId, ...others] = [...server.threadIds];
  if (threadId === undefined || others.length > 0) {
    throw new Error("Expected the page to read exactly one draft thread");
  }
  testing.act(() => {
    useChatDraftStore.getState().insertInlineContent(
      getChatThreadKey({
        scope: "global",
        threadId: toChatThreadId(threadId),
      }),
      [{ type: "text", text }],
    );
  });
};

const AUTO_LABEL = messages.chat.modelSelector.autoLabel;
const CODEX_LABEL = "Codex · GPT-5 Codex";

test("a new chat runs on the member's computer when they choose it, and its first send goes there", async () => {
  const server = serve();
  const client = createClient();
  const { ui, appRouter } = await openNewChat(client);

  // The dock's model menu offers Run on before the chat has a thread.
  const trigger = await ui.findByRole("button", { name: AUTO_LABEL });
  await testing.act(async () => {
    testing.fireEvent.click(trigger);
  });
  expect(await ui.findByText(messages.chat.localRun.runOn)).toBeTruthy();
  const codex = await ui.findByText("Codex on this computer");
  await testing.act(async () => {
    testing.fireEvent.click(codex);
  });
  const model = await ui.findByText("GPT-5 Codex");
  await testing.act(async () => {
    testing.fireEvent.click(model);
  });

  // The choice is stored on the draft's row and reads back on the dock.
  await testing.waitFor(() =>
    expect(server.patches).toEqual([
      { model: null, reasoningEffort: null, runTarget: CODEX },
    ]),
  );
  expect(await ui.findByRole("button", { name: CODEX_LABEL })).toBeTruthy();

  typeDraft(server, "Run the tests");
  const send = await ui.findByRole("button", {
    name: messages.chat.sendPrompt,
  });
  await testing.waitFor(() =>
    expect(send.hasAttribute("disabled")).toBe(false),
  );
  await testing.act(async () => {
    testing.fireEvent.click(send);
  });
  await testing.waitFor(() => expect(server.sends).toHaveLength(1));
  expect(server.sends.at(0)).toMatchObject({
    forwardedProps: { runTarget: CODEX },
  });
  await testing.waitFor(() =>
    expect(appRouter.state.location.pathname).toMatch(/^\/chat\/[^/]+$/u),
  );
  // The next new chat starts there.
  expect(
    useChatRunOnPreferenceStore.getState().byOrganization[
      user.activeOrganizationId
    ],
  ).toEqual(CODEX);
  expect(server.unexpected).toEqual([]);
});

/** Type into the new chat and send; the request the page sent. */
const sendFirstTurn = async (
  server: ReturnType<typeof serve>,
  ui: Awaited<ReturnType<typeof openNewChat>>["ui"],
) => {
  typeDraft(server, "Run the tests");
  const send = await ui.findByRole("button", {
    name: messages.chat.sendPrompt,
  });
  await testing.waitFor(() =>
    expect(send.hasAttribute("disabled")).toBe(false),
  );
  await testing.act(async () => {
    testing.fireEvent.click(send);
  });
  await testing.waitFor(() => expect(server.sends).toHaveLength(1));
  return server.sends.at(0);
};

test("a new chat opens on the member's last Run on choice, and its first send goes there", async () => {
  rememberRunTarget(user.activeOrganizationId, CODEX);
  const server = serve();
  const client = createClient();
  const { ui } = await openNewChat(client);

  expect(await ui.findByRole("button", { name: CODEX_LABEL })).toBeTruthy();
  expect(await sendFirstTurn(server, ui)).toMatchObject({
    forwardedProps: { runTarget: CODEX },
  });
  // Nothing was written to start there.
  expect(server.patches).toEqual([]);
  expect(server.unexpected).toEqual([]);
});

test("a new chat whose remembered computer is offline says so in the bar and does not move to stella cloud", async () => {
  rememberRunTarget(user.activeOrganizationId, CODEX);
  const server = serve(OFFLINE);
  const client = createClient();
  const { ui } = await openNewChat(client);

  const offline = `${CODEX_LABEL} · ${messages.chat.localRun.stateOffline}`;
  expect(await ui.findByRole("button", { name: offline })).toBeTruthy();
  expect(ui.queryByRole("button", { name: AUTO_LABEL })).toBeNull();
  // A send goes to the computer, which the API refuses with its reason, and
  // never to stella's models in its place.
  expect(await sendFirstTurn(server, ui)).toMatchObject({
    forwardedProps: { runTarget: CODEX },
  });
  expect(server.unexpected).toEqual([]);
});

test("a new chat left on stella cloud sends its first turn without a computer", async () => {
  const server = serve();
  const client = createClient();
  const { ui } = await openNewChat(client);
  await ui.findByRole("button", { name: AUTO_LABEL });

  typeDraft(server, "Summarise the clause");
  const send = await ui.findByRole("button", {
    name: messages.chat.sendPrompt,
  });
  await testing.waitFor(() =>
    expect(send.hasAttribute("disabled")).toBe(false),
  );
  await testing.act(async () => {
    testing.fireEvent.click(send);
  });
  await testing.waitFor(() => expect(server.sends).toHaveLength(1));
  expect(server.sends.at(0)).toMatchObject({ forwardedProps: {} });
  expect(server.sends.at(0)).not.toMatchObject({
    forwardedProps: { runTarget: expect.anything() },
  });
  expect(server.patches).toEqual([]);
  expect(server.unexpected).toEqual([]);
});
