import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A DOM for this file only: the rendered chat is clicked and its effects run,
// which a static render cannot do. Everything that touches the DOM is loaded
// after it exists.
GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

// The network, for this file: every request goes to the recorded server of
// the conversation on screen. Installed before the app loads, so a client
// that keeps a reference to `fetch` keeps this one.
const originalFetch = globalThis.fetch;
let routeRequest:
  | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
  | undefined;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    if (routeRequest === undefined) {
      // Between conversations (the app's session check at load) nothing
      // answers.
      return Response.json({ message: "No server" }, { status: 503 });
    }
    return await routeRequest(input, init);
  },
  { preconnect: () => undefined },
);

const React = await import("react");
const { QueryClient, QueryClientProvider, useSuspenseQuery } =
  await import("@tanstack/react-query");
const testing = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { ChatMattersContext } =
  await import("@/components/chat/chat-matters-context");
const { getToolApprovalGrant, isApprovalToolName } =
  await import("@/components/chat/chat-ui-tools");
const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");
const { useChatSession } =
  await import("@/features/chat/hooks/use-chat-session");
const { useChatThreadRuntime } =
  await import("@/features/chat/hooks/use-chat-thread-runtime");
const { __resetChatRequestStateForTests, chatThreadOptions } =
  await import("@/features/chat/queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { mcpConnectorsOptions } = await import("@/lib/knowledge/queries");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { toSafeId } = await import("@/lib/safe-id");
const { default: messages } = await import("@/i18n/langs/en.json");

const actEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
beforeAll(() => {
  // A recorded response streams in on its own schedule, as the network
  // delivers it, not inside a test's `act()`; the page is read once it has
  // settled.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

afterAll(async () => {
  // Let React's scheduled work drain before the DOM goes away.
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

// Conversations the real send pipeline served, replayed through the chat a
// user sees: the thread page's own wiring (`chatThreadOptions`,
// `useChatThreadRuntime`, `useChatSession`, `ChatThreadMessages` and its
// approval, ask-user and draft cards), fed by the recorded SSE through a fake
// server. Nothing under test is mocked: the fake stands where the network is.
// The recordings come from `apps/api/src/handlers/chat/
// recorded-conversations.integration.test.ts`, which fails when they drift
// from the server.

// --- Recordings ------------------------------------------------------------

type RecordedPage = {
  lastActivityAt: string | null;
  messages: unknown[];
  olderCursor: string | null;
};
type RecordedExchange = {
  ended: "complete" | "connection-lost" | "disconnected";
  page: RecordedPage;
  request: Record<string, unknown>;
  response: { body: string; status: number };
};
type RecordedAction =
  | { messageId: string; text: string; type: "send" }
  | {
      decision: "allow-once" | "deny";
      toolCallId: string;
      type: "approve";
    }
  | { toolCallId: string; type: "auto-approve" }
  | { answer: string; toolCallId: string; type: "answer" }
  | { tool: string; toolCallId: string; type: "client-tool" }
  | { type: "stop" }
  | { type: "drop-connection" };
type RecordedConversation = {
  initialPage: RecordedPage;
  scenario: string;
  steps: { action: RecordedAction; exchanges: RecordedExchange[] }[];
  threadId: string;
};

const FIXTURE_DIR = path.join(
  import.meta.dir,
  "__fixtures__/recorded-conversations",
);
const RECORDING_EXTENSION = ".gen.json";

const readRecording = (scenario: string): RecordedConversation => {
  const parsed: unknown = JSON.parse(
    readFileSync(
      path.join(FIXTURE_DIR, `${scenario}${RECORDING_EXTENSION}`),
      "utf-8",
    ),
  );
  // SAFETY: the recorder writes exactly this shape (its
  // `RecordedConversation`); the step kinds and endings it may use are
  // checked below, so a recorder that adds one fails here, not silently.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the SAFETY note above.
  const recording = parsed as RecordedConversation;
  for (const { action, exchanges } of recording.steps) {
    expect(STEP_KINDS, scenario).toContain(action.type);
    for (const { ended } of exchanges) {
      expect(EXCHANGE_ENDINGS, scenario).toContain(ended);
    }
  }
  return recording;
};

/** Every step kind and response ending this replay performs. */
const STEP_KINDS: readonly RecordedAction["type"][] = [
  "answer",
  "approve",
  "auto-approve",
  "client-tool",
  "drop-connection",
  "send",
  "stop",
];
const EXCHANGE_ENDINGS: readonly RecordedExchange["ended"][] = [
  "complete",
  "connection-lost",
  "disconnected",
];

// --- The fake server -------------------------------------------------------

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const API_ORIGIN = "http://localhost:3001";
/** What the page shows while a part of it is still loading. */
const SUSPENDED = "The page is loading";

type Posted = { body: Record<string, unknown>; exchange: RecordedExchange };

/**
 * Answers the page's chat requests with the recorded responses, in order, and
 * serves the message page as it stood after the latest answered request. A
 * response recorded as cut off streams what the page read before the cut and
 * then stays open until the page stops it or `dropConnection` drops it.
 */
const createRecordedServer = (recording: RecordedConversation) => {
  const exchanges = recording.steps.flatMap((step) => step.exchanges);
  const posted: Posted[] = [];
  const unexpected: string[] = [];
  let page = recording.initialPage;
  let revision = 0;
  let drop: (() => void) | undefined;
  /** Responses the page is still reading. */
  let streaming = 0;
  /** A cut-off response has delivered all it will. */
  let stalled = false;

  const threadPage = () =>
    Response.json({
      ...page,
      context: null,
      contextMatterIds: [],
      forkProvenance: { type: "none" },
      model: null,
      reasoningEffort: null,
      // Every settled request writes the thread, which moves its revision.
      threadRevision: `revision-${String(revision)}`,
      threadExists: page.messages.length > 0,
      usedAnonymization: false,
      webSearchAvailable: false,
      webSearchEnabled: false,
    });

  const settle = (exchange: RecordedExchange) => {
    page = exchange.page;
    revision += 1;
  };

  const answerChat = (
    body: Record<string, unknown>,
    signal: AbortSignal | null | undefined,
  ): Response => {
    const exchange = exchanges[posted.length];
    if (exchange === undefined) {
      // A request the recorded page never sent. It is left unanswered, so
      // the finding is this request rather than what the page makes of an
      // error answer.
      unexpected.push(`POST /chat #${String(posted.length + 1)}`);
      return new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    posted.push({ body, exchange });
    if (exchange.ended === "connection-lost") {
      // The process serving it died: the request fails with no response.
      settle(exchange);
      throw new TypeError("Failed to fetch");
    }
    if (exchange.response.status !== 200) {
      settle(exchange);
      return new Response(exchange.response.body, {
        headers: { "content-type": "application/json" },
        status: exchange.response.status,
      });
    }
    // The server answers under the run id it was asked for.
    const recordedRunId = exchange.request["runId"];
    const runId = body["runId"];
    const sse =
      typeof recordedRunId === "string" && typeof runId === "string"
        ? exchange.response.body.replaceAll(recordedRunId, () => runId)
        : exchange.response.body;
    const events = sse.split(/(?<=\n\n)/u).filter((event) => event !== "");
    const encoder = new TextEncoder();
    let index = 0;
    let open = true;
    streaming += 1;
    const close = () => {
      open = false;
      streaming -= 1;
      stalled = false;
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const cut = (error: Error) => {
          if (!open) {
            return;
          }
          close();
          settle(exchange);
          controller.error(error);
        };
        signal?.addEventListener(
          "abort",
          () => {
            cut(new DOMException("The page aborted", "AbortError"));
          },
          { once: true },
        );
        drop = () => {
          cut(new TypeError("The connection dropped"));
        };
      },
      pull: async (controller) => {
        // One event per read, a task apart, as a network delivers them.
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        if (!open) {
          return;
        }
        const event = events[index];
        index += 1;
        const last = index === events.length;
        if (event !== undefined) {
          if (last && exchange.ended === "complete") {
            // The server has stored the turn by the time its last event is
            // written, so a page load it triggers reads the settled thread.
            settle(exchange);
          }
          controller.enqueue(encoder.encode(event));
          stalled = last && exchange.ended === "disconnected";
          return;
        }
        if (exchange.ended === "complete") {
          close();
          controller.close();
          return;
        }
        // A cut-off response stays open: nothing more arrives.
        stalled = true;
        await new Promise<void>(() => {
          // Never settles: the page ends this response, not the server.
        });
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  };

  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    await Promise.resolve();
    const request = input instanceof Request ? input : undefined;
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? request?.method ?? "GET";
    if (url.origin === API_ORIGIN && url.pathname === "/v1/chat") {
      const text =
        typeof init?.body === "string" ? init.body : await request?.text();
      const body: unknown = JSON.parse(text ?? "null");
      if (!isJsonObject(body)) {
        unexpected.push("POST /chat without a JSON body");
        return Response.json({}, { status: 400 });
      }
      return answerChat(body, init?.signal);
    }
    if (
      url.origin === API_ORIGIN &&
      method === "GET" &&
      url.pathname === `/v1/chat/threads/${recording.threadId}/messages`
    ) {
      return threadPage();
    }
    unexpected.push(`${method} ${url.pathname}`);
    return Response.json({ message: "Not recorded" }, { status: 404 });
  };

  return {
    dropConnection: () => {
      (drop ?? expect.unreachable("No response is streaming"))();
    },
    fetch,
    posted,
    /** The thread's page as the server would serve it now. */
    page: () => page,
    /** Whether a cut-off response has delivered all it will. */
    stalled: () => stalled,
    /** Responses the page is still reading. */
    streaming: () => streaming,
    unexpected,
  };
};

// --- The page ------------------------------------------------------------

type Session = ReturnType<typeof useChatSession>;

/** The thread page's chat, wired as `ChatThreadPage` wires it. */
const RecordedThreadPage = ({
  onSession,
  organizationId,
  threadId,
}: {
  onSession: (session: Session) => void;
  organizationId: string;
  threadId: string;
}) => {
  const threadRef = {
    scope: "global",
    threadId: toChatThreadId(threadId),
  } as const;
  const chatThreadContext = { allowMissingThread: true };
  const { data } = useSuspenseQuery(
    chatThreadOptions({
      activeOrganizationId: organizationId,
      context: chatThreadContext,
      key: threadRef,
    }),
  );
  const chat = useChatThreadRuntime({
    activeOrganizationId: organizationId,
    context: chatThreadContext,
    data,
    key: threadRef,
  });
  const session = useChatSession({
    chat,
    conversationId: threadId,
    initialOlderCursor: data.olderCursor,
    threadRef,
  });
  onSession(session);
  return (
    <ChatMattersContext
      value={{
        createDocumentMatters: session.createDocumentMatters,
        isLoadingCreateDocumentMatters: session.isLoadingCreateDocumentMatters,
      }}
    >
      <ChatApprovalContext
        value={{
          activeOrganizationId: organizationId,
          alwaysApprovedTools: session.alwaysApprovedTools,
          conversationApprovedTools: session.conversationApprovedTools,
          handleAllowInConversation: session.handleAllowInConversation,
          handleAlwaysAllow: session.handleAlwaysAllow,
          handleApprove: session.handleApprove,
          handleDeny: session.handleDeny,
        }}
      >
        <ChatThreadMessages
          approvalPendingMessageId={session.approvalPendingMessageId}
          error={session.error}
          hasOlderMessages={session.olderCursor !== null}
          isGenerating={session.isGenerating}
          isLoadingOlder={session.isLoadingOlder}
          loadOlderError={session.loadOlderError}
          messages={session.messages}
          onAskUserEditAndRerun={session.handleAskUserEditAndRerun}
          onAskUserSubmit={session.handleAskUserSubmit}
          onCreateDocumentResolve={session.handleCreateDocumentResolve}
          onLoadOlder={session.loadOlder}
          onOpenCreateDocumentDraft={session.handleOpenCreateDocumentDraft}
          onOpenCreatedDocument={session.handleOpenCreatedDocument}
          onRemoveQueuedMessage={session.removeQueuedMessage}
          onResend={session.resendLatestMessage}
          queuedMessages={session.queuedMessages}
          showThinkingIndicator
          streamdownComponents={session.streamdownComponents}
          threadRef={threadRef}
        />
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

/** A tab on the recorded thread, loaded the way the page loads it. */
const openPage = async (
  recording: RecordedConversation,
  { organizationId = ORGANIZATION_ID }: { organizationId?: string } = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Lists the chat reads beside the thread, answered as empty.
  queryClient.setQueryData(mcpConnectorsOptions(organizationId).queryKey, {
    canManageCustomConnectors: false,
    connectors: [],
    nativeTools: [],
  });
  queryClient.setQueryData(
    workspacesNavigationOptions(organizationId).queryKey,
    { workspaces: [] },
  );
  let session: Session | undefined;
  const view = testing.render(
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: organizationId,
              email: "user@example.com",
              id: "00000000-0000-7000-8000-00000000fffe",
              image: null,
              name: "User",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <React.Suspense fallback={<p>{SUSPENDED}</p>}>
              <RecordedThreadPage
                onSession={(next) => {
                  session = next;
                }}
                organizationId={organizationId}
                threadId={recording.threadId}
              />
            </React.Suspense>
          </AuthenticatedUserProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>,
  );
  await testing.waitFor(() => {
    expect(session).toBeDefined();
    expect(testing.within(view.container).queryByText(SUSPENDED)).toBeNull();
  });
  return {
    session: () => session ?? expect.unreachable("The page is not rendered"),
    view,
  };
};

afterEach(() => {
  testing.cleanup();
  routeRequest = undefined;
  __resetChatRequestStateForTests();
  sessionStorage.clear();
  localStorage.clear();
});

const { act, fireEvent, waitFor, within } = testing;

const sleep = async (ms: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Lets the page finish what the last event started: renders, effects and
 *  the page load a finished turn triggers. */
const flush = async () => {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await sleep(10);
    });
  }
};

// --- What the user sees ------------------------------------------------------

/** The chat as the user sees it: which cards ask for an answer, which calls
 *  show as approved or denied, how many folded step lists the turns show, and
 *  whether anything still looks busy. */
type ScreenState = {
  actionable: string[];
  approved: string[];
  busy: boolean;
  denied: string[];
  stepLists: number;
};

const ALLOW_ONCE = messages.chat.approval.allowOnce;
const DENY = messages.chat.approval.deny;
const ALLOWED = messages.chat.approval.allowed;
const DENIED = messages.chat.approval.denied;
const SUBMIT_ANSWERS = messages.chat.askUser.submit;
const ANSWER_PLACEHOLDER = messages.chat.askUser.placeholder;
const ASK_USER_TITLE = messages.chat.tool["ask-user"];
const BUSY_TEXTS = [messages.chat.thinking, messages.chat.analyzingSources];
/** The approval tool the recordings call; its one input is the call's id. */
const CALL_ID_PATTERN = /^call-\d+$/u;
/** A folded step list's summary (`common.stepCount`). */
const STEP_COUNT_PATTERN = /^\d+ steps?$/u;

/**
 * Every card frame on screen. A card is the bordered box a tool call renders
 * in (`ToolApprovalCard`, `AskUserCard`), found by the text a user reads in
 * it: an approval card lists its request (the recorded calls send their own
 * id), an ask-user card carries its title.
 */
const cardFrames = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("div.rounded-lg.border")].filter(
    (frame) =>
      (frame.parentElement?.closest("div.rounded-lg.border") ?? null) === null,
  );

const approvalCallId = (frame: HTMLElement): string | null =>
  [...frame.querySelectorAll("dd")]
    .map((cell) => cell.textContent.trim())
    .find((text) => CALL_ID_PATTERN.test(text)) ?? null;

const hasButton = (frame: HTMLElement, name: string) =>
  within(frame).queryByRole("button", { name }) !== null;

const readScreen = (container: HTMLElement): ScreenState => {
  const state: ScreenState = {
    actionable: [],
    approved: [],
    busy:
      container.querySelector(".animate-spin, .animate-skeleton") !== null ||
      BUSY_TEXTS.some((text) => container.textContent.includes(text)),
    denied: [],
    stepLists: [...container.querySelectorAll("summary")].filter((summary) =>
      STEP_COUNT_PATTERN.test(summary.textContent.trim()),
    ).length,
  };
  let askUserIndex = 0;
  for (const frame of cardFrames(container)) {
    const callId = approvalCallId(frame);
    if (callId !== null) {
      if (hasButton(frame, ALLOW_ONCE) && hasButton(frame, DENY)) {
        state.actionable.push(callId);
      }
      // The card's status mark, by the name it announces.
      if (within(frame).queryByRole("img", { name: ALLOWED }) !== null) {
        state.approved.push(callId);
      }
      if (within(frame).queryByRole("img", { name: DENIED }) !== null) {
        state.denied.push(callId);
      }
      continue;
    }
    if (frame.textContent.includes(ASK_USER_TITLE)) {
      askUserIndex += 1;
      if (hasButton(frame, SUBMIT_ANSWERS)) {
        state.actionable.push(`ask-user-${String(askUserIndex)}`);
      }
    }
  }
  return state;
};

/** A stored tool call, as the message page serves it. */
type PageToolCall = {
  approval?: { approved?: boolean; id: string } | undefined;
  id: string;
  name: string;
  output?: unknown;
  state: string;
};

const isPageToolCall = (part: unknown): part is PageToolCall =>
  typeof part === "object" &&
  part !== null &&
  Reflect.get(part, "type") === "tool-call" &&
  typeof Reflect.get(part, "id") === "string";

/** Tools whose calls render as their own card rather than as a step. */
const CARD_TOOL_NAMES = new Set(["ask-user", "create-document"]);

/**
 * How a stored part reads in a turn: a step the turn folds into its step list
 * (a thought, or a call of a tool that asks nothing), a transport companion
 * the user never sees (a call's result), or content that ends a step list.
 */
const partRole = (part: unknown): "content" | "step" | "unseen" => {
  if (!isJsonObject(part)) {
    return "content";
  }
  if (part["type"] === "tool-result") {
    return "unseen";
  }
  if (part["type"] === "thinking") {
    const content = part["content"];
    return typeof content === "string" && content.trim() !== ""
      ? "step"
      : "unseen";
  }
  if (isPageToolCall(part)) {
    return part.approval === undefined && !CARD_TOOL_NAMES.has(part.name)
      ? "step"
      : "content";
  }
  return "content";
};

const partsOf = (message: unknown): unknown[] => {
  const parts: unknown =
    typeof message === "object" && message !== null
      ? Reflect.get(message, "parts")
      : undefined;
  return Array.isArray(parts) ? parts : [];
};

/** A turn's step lists: its runs of steps, however many results sit between
 *  them. */
const countStepLists = (parts: readonly unknown[]): number => {
  let lists = 0;
  let inList = false;
  for (const part of parts) {
    const role = partRole(part);
    if (role === "step" && !inList) {
      lists += 1;
    }
    if (role !== "unseen") {
      inList = role === "step";
    }
  }
  return lists;
};

/**
 * What the server's stored thread says the user must see once the page is
 * idle: every open approval and question as a card to answer, every denied
 * call denied, every approved call that ran approved, each run of a turn's
 * steps in one list, and nothing busy. Read from the stored page alone, never
 * from what the web app made of it.
 */
const expectedScreen = (page: RecordedPage): ScreenState => {
  const state: ScreenState = {
    actionable: [],
    approved: [],
    busy: false,
    denied: [],
    stepLists: page.messages.reduce(
      (total: number, message) => total + countStepLists(partsOf(message)),
      0,
    ),
  };
  let askUserIndex = 0;
  for (const message of page.messages) {
    for (const part of partsOf(message)) {
      if (!isPageToolCall(part)) {
        continue;
      }
      if (part.name === "ask-user") {
        askUserIndex += 1;
        if (part.output === undefined) {
          state.actionable.push(`ask-user-${String(askUserIndex)}`);
        }
        continue;
      }
      if (part.approval === undefined) {
        continue;
      }
      if (part.state === "approval-requested") {
        state.actionable.push(part.id);
      } else if (part.approval.approved === false) {
        state.denied.push(part.id);
      } else if (part.approval.approved === true && part.state === "complete") {
        state.approved.push(part.id);
      }
    }
  }
  return state;
};

// --- Requests ------------------------------------------------------------------

const CLIENT_ID_PATTERN = /(?:run|msg)-(?:recorded-\d+|\d{13}-[0-9a-z]{6})/gu;
const INSTANT_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
};

/**
 * A conversation's request bodies with the values a page mints for itself
 * made comparable: its run and message ids keep their identity across the
 * whole conversation (named by first appearance), instants are dropped, and
 * object keys are sorted. Every other value, the thread's and messages' ids
 * included, must be equal.
 */
const comparableRequests = (bodies: readonly unknown[]): unknown[] => {
  const names = new Map<string, string>();
  const rename = (match: string) => {
    const known = names.get(match);
    if (known !== undefined) {
      return known;
    }
    const next = `${match.slice(0, 3)}-${String(names.size + 1)}`;
    names.set(match, next);
    return next;
  };
  return bodies.map((body): unknown =>
    JSON.parse(
      JSON.stringify(sortKeys(body))
        .replaceAll(CLIENT_ID_PATTERN, rename)
        .replaceAll(INSTANT_PATTERN, "<instant>"),
    ),
  );
};

// --- Replaying a recording -----------------------------------------------------

const RELOAD_ORGANIZATION_ID = "00000000-0000-7000-8000-00000000fffd";
/** Where the page keeps a conversation's grants for the tab's lifetime
 *  (`use-chat-session.ts`). */
const CONVERSATION_GRANTS_KEY = "stella.chat.conversationApprovedTools:";

/** Opens a second tab on the thread as it is stored now and reads it. */
const readReload = async (
  recording: RecordedConversation,
): Promise<ScreenState> => {
  const reload = await openPage(recording, {
    organizationId: RELOAD_ORGANIZATION_ID,
  });
  await flush();
  const state = readScreen(reload.view.container);
  reload.view.unmount();
  return state;
};

/** The approval card showing `toolCallId`, with its buttons. */
const approvalCard = (container: HTMLElement, toolCallId: string) =>
  cardFrames(container).find((frame) => approvalCallId(frame) === toolCallId) ??
  expect.unreachable(`No approval card shows ${toolCallId}`);

/** Steps the page completes on its own, with no user action. */
const isAutomatic = (action: RecordedAction) =>
  action.type === "auto-approve" || action.type === "client-tool";

const storedToolCalls = (recording: RecordedConversation) =>
  recording.steps
    .flatMap(({ exchanges }) => exchanges)
    .flatMap(({ page }) => page.messages)
    .flatMap((message) => {
      const parts: unknown =
        typeof message === "object" && message !== null
          ? Reflect.get(message, "parts")
          : undefined;
      return Array.isArray(parts) ? parts.filter(isPageToolCall) : [];
    });

/**
 * The grants the tab holds before the conversation starts: the tools whose
 * approvals the recording answers without a click, allowed for this
 * conversation earlier in the tab.
 */
const grantConversationTools = (recording: RecordedConversation) => {
  const calls = storedToolCalls(recording);
  const granted = new Set(
    recording.steps.flatMap(({ action }) =>
      action.type === "auto-approve"
        ? [
            (
              calls.find(({ id }) => id === action.toolCallId) ??
              expect.unreachable(`No stored call ${action.toolCallId}`)
            ).name,
          ]
        : [],
    ),
  );
  if (granted.size === 0) {
    return;
  }
  sessionStorage.setItem(
    `${CONVERSATION_GRANTS_KEY}${recording.threadId}`,
    JSON.stringify(
      [...granted].map((name) =>
        isApprovalToolName(name)
          ? getToolApprovalGrant(name)
          : expect.unreachable(`${name} is not an approval tool`),
      ),
    ),
  );
};

/** The requests a posted body answers: the interrupt ids it resumes. */
const resumedInterrupts = (body: Record<string, unknown>): string[] => {
  const resume = body["resume"];
  return Array.isArray(resume)
    ? resume.flatMap((item: unknown) => {
        const id: unknown =
          typeof item === "object" && item !== null
            ? Reflect.get(item, "interruptId")
            : undefined;
        return typeof id === "string" ? [id] : [];
      })
    : [];
};

const performAction = async ({
  action,
  container,
  live,
  server,
}: {
  action: RecordedAction;
  container: HTMLElement;
  live: Awaited<ReturnType<typeof openPage>>;
  server: ReturnType<typeof createRecordedServer>;
}) => {
  switch (action.type) {
    case "send": {
      // What the composer hands the session on submit.
      await act(async () => {
        void live
          .session()
          .sendMessage({
            content: action.text,
            id: toSafeId<"chatMessage">(action.messageId),
          })
          .catch(() => undefined);
        await sleep(0);
      });
      return;
    }
    case "approve": {
      const name = action.decision === "deny" ? DENY : ALLOW_ONCE;
      fireEvent.click(
        within(approvalCard(container, action.toolCallId)).getByRole("button", {
          name,
        }),
      );
      return;
    }
    case "answer": {
      fireEvent.change(
        within(container).getByPlaceholderText(ANSWER_PLACEHOLDER),
        { target: { value: action.answer } },
      );
      fireEvent.click(
        within(container).getByRole("button", { name: SUBMIT_ANSWERS }),
      );
      return;
    }
    case "stop": {
      // The composer's Stop.
      act(() => {
        live.session().stop();
      });
      return;
    }
    case "drop-connection": {
      act(() => {
        server.dropConnection();
      });
      return;
    }
    case "auto-approve":
    case "client-tool": {
      return;
    }
    default: {
      action satisfies never;
      expect.unreachable("A recorded step this replay cannot perform");
    }
  }
};

/**
 * The checks this file runs, by the ids the chat mutation matrix
 * (`apps/api/scripts/chat-mutation-matrix.json`) names: a failure message
 * carries its check's id, so the matrix can tell a check that caught a
 * mutation from a test that broke for another reason.
 */
const RENDER_ORACLE = {
  /** The page shows what the stored thread says: open cards, marks, step
   *  lists, and nothing busy once idle. */
  cardsMatchStored: "chat.render.cards-match-stored",
  /** A second tab loading the thread shows what the live page shows. */
  reloadMatchesLive: "chat.render.reload-matches-live",
  /** The page posts exactly the recorded requests, and only those. */
  requestsMatchRecorded: "chat.render.requests-match-recorded",
  /** A conversation grant answers each matching approval exactly once. */
  grantAnswersOnce: "chat.render.grant-answers-once",
} as const;

const finding = (
  oracle: (typeof RENDER_ORACLE)[keyof typeof RENDER_ORACLE],
  where: string,
) => JSON.stringify({ oracle, where });

/**
 * Replays `scenario` through the rendered chat. After every step the user
 * could look at, what the page shows must be what the stored thread says,
 * and a second tab loading the thread must show the same; at the end the page
 * must have posted exactly the recorded requests.
 */
const replay = async (scenario: string) => {
  const recording = readRecording(scenario);
  const server = createRecordedServer(recording);
  routeRequest = server.fetch;
  grantConversationTools(recording);
  const live = await openPage(recording);
  const container = live.view.container;
  /** Cards answered since the last request, held by the page alone. */
  const answeredLocally: string[] = [];
  for (const [index, { action, exchanges }] of recording.steps.entries()) {
    const expectedPosts = recording.steps
      .slice(0, index + 1)
      .reduce((total, step) => total + step.exchanges.length, 0);
    await performAction({ action, container, live, server });
    const next = recording.steps[index + 1];
    if (next !== undefined && isAutomatic(next.action)) {
      // The page answers on its own; the check comes once it has.
      continue;
    }
    const where = `${scenario}, step ${String(index + 1)} (${action.type})`;
    const requests = finding(RENDER_ORACLE.requestsMatchRecorded, where);
    const midStream =
      exchanges.at(-1)?.ended === "disconnected" && next !== undefined;
    await waitFor(
      () => {
        expect(server.posted.length, requests).toBe(expectedPosts);
        expect(
          midStream ? server.stalled() : server.streaming() === 0,
          requests,
        ).toBe(true);
        expect(within(container).queryByText(SUSPENDED)).toBeNull();
      },
      { timeout: 5000 },
    );
    await flush();
    // Only the recorded requests, and nothing the recording did not serve.
    expect(server.posted.length, requests).toBe(expectedPosts);
    expect(server.unexpected, requests).toEqual([]);
    if (midStream) {
      continue;
    }
    const shown = readScreen(container);
    const stored = expectedScreen(server.page());
    const cards = finding(RENDER_ORACLE.cardsMatchStored, where);
    if (exchanges.length === 0 && action.type === "approve") {
      // An answer inside a batch stays on the page until the batch is sent:
      // that card no longer asks, the others still do.
      answeredLocally.push(action.toolCallId);
      expect(shown.actionable, cards).toEqual(
        stored.actionable.filter((id) => !answeredLocally.includes(id)),
      );
      continue;
    }
    answeredLocally.length = 0;
    // The one documented difference (TEXT_BEFORE_TOOL_CARDS in the api
    // harness): after an interrupt the live page shows a turn's text ahead of
    // its tool calls, so its steps can fold differently until a reload. Step
    // lists are checked where the stored order shows: in the second tab.
    const { stepLists: _liveStepLists, ...liveCards } = shown;
    const { stepLists: _storedStepLists, ...storedCards } = stored;
    expect(liveCards, cards).toEqual(storedCards);
    const reloaded = await readReload(recording);
    expect(reloaded, cards).toEqual(stored);
    const { stepLists: _reloadedStepLists, ...reloadedCards } = reloaded;
    expect(
      reloadedCards,
      finding(RENDER_ORACLE.reloadMatchesLive, where),
    ).toEqual(liveCards);
  }
  // The page posted what the recorded page posted, request for request.
  expect(
    comparableRequests(server.posted.map(({ body }) => body)),
    finding(RENDER_ORACLE.requestsMatchRecorded, scenario),
  ).toEqual(
    comparableRequests(server.posted.map(({ exchange }) => exchange.request)),
  );
  return { recording, server };
};

const SCENARIOS = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(RECORDING_EXTENSION))
  .map((file) => file.slice(0, -RECORDING_EXTENSION.length));

/** A replay renders the thread once per checked step, in a second tab. */
const REPLAY_TIMEOUT_MS = 60_000;

describe("a recorded conversation, rendered", () => {
  test.each(SCENARIOS)(
    "%s shows what the server stored, live and in a second tab",
    async (scenario) => {
      await replay(scenario);
    },
    REPLAY_TIMEOUT_MS,
  );

  test(
    "a conversation grant answers each matching approval exactly once, without a click",
    async () => {
      const { recording, server } = await replay("conversation-grant");
      const autoApproved = recording.steps.flatMap(({ action }) =>
        action.type === "auto-approve" ? [action.toolCallId] : [],
      );
      // The fixture must reach the grant: two approvals, neither clicked.
      expect(autoApproved).toEqual(["call-1", "call-2"]);
      const answered = server.posted.flatMap(({ body }) =>
        resumedInterrupts(body),
      );
      for (const toolCallId of autoApproved) {
        const interruptId = storedToolCalls(recording).find(
          ({ id }) => id === toolCallId,
        )?.approval?.id;
        expect(
          answered.filter((id) => id === interruptId),
          finding(RENDER_ORACLE.grantAnswersOnce, toolCallId),
        ).toHaveLength(1);
      }
    },
    REPLAY_TIMEOUT_MS,
  );

  test("the recordings cover every kind of step", () => {
    const kinds = new Set(
      SCENARIOS.flatMap((scenario) =>
        readRecording(scenario).steps.map(({ action }) => action.type),
      ),
    );
    expect([...kinds].toSorted()).toEqual(STEP_KINDS.toSorted());
  });
});
