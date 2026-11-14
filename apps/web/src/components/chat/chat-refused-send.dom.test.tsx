import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER, CHAT_TURN_INTENT } from "@stll/api-contract";
import { CHAT_LOCAL_RUN_REFUSAL } from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

// The network, for this file. Installed before the app loads, so a client
// that keeps a reference to `fetch` keeps this one.
const originalFetch = globalThis.fetch;
let routeRequest:
  | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
  | undefined;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) =>
    routeRequest === undefined
      ? Response.json({ message: "No server" }, { status: 503 })
      : await routeRequest(input, init),
  { preconnect: () => undefined },
);

const { act } = await import("react");
const { cleanup, fireEvent, waitFor, within } =
  await import("@testing-library/react");
const { default: messages } = await import("@/i18n/langs/en.json");
const { openChatThreadDomPage } =
  await import("@/components/chat/chat-thread-dom-page");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/chat-runtime-registry");
const { chatKeys } = await import("@/features/chat/chat-query-contract");
const { toSafeId } = await import("@/lib/safe-id");

afterEach(async () => {
  await act(async () => cleanup());
  routeRequest = undefined;
  __resetChatRequestStateForTests();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const API_ORIGIN = "http://localhost:3001";
const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const THREAD_ID = "00000000-0000-7000-8000-0000000000b1";
const TURN_ID = "00000000-0000-7000-8000-0000000000b2";
const FIRST_ID = "00000000-0000-7000-8000-0000000000c1";
const FIRST_ANSWER_ID = "00000000-0000-7000-8000-0000000000c2";
const REFUSED_ID = "00000000-0000-7000-8000-0000000000c3";
const ANSWER_ID = "00000000-0000-7000-8000-0000000000c4";
const REFUSED_TEXT = "Which leases end this year?";
const ANSWER = "Two of them.";
const NO_COMPUTER = messages.chat.localRun.refusalNoComputer;

type StoredMessage = {
  createdAt: string;
  edited: boolean;
  id: string;
  metadata: Record<string, unknown>;
  parts: { type: "text"; content: string }[];
  revision: number;
  role: "user" | "assistant";
};

const stored = (
  id: string,
  role: StoredMessage["role"],
  content: string,
): StoredMessage => ({
  createdAt: "2026-01-01T00:00:10.000Z",
  edited: false,
  id,
  metadata: role === "assistant" ? { turnOutcome: { type: "completed" } } : {},
  parts: [{ type: "text", content }],
  revision: 0,
  role,
});

/**
 * The API as a chat on the member's computer meets it. While no computer is
 * connected a send is refused before anything of it is stored, though the
 * request has touched the thread's row by then (the first send of an empty
 * thread titles it), so the next read carries a new revision. A regeneration
 * is taken only for a message the thread stores.
 */
type Server = {
  connected: boolean;
  stored: StoredMessage[];
  revision: number;
  posted: Record<string, unknown>[];
  unexpected: string[];
};

const serve = (history: StoredMessage[]) => {
  const state: Server = {
    connected: false,
    stored: history,
    revision: history.length === 0 ? 0 : 1,
    posted: [],
    unexpected: [],
  };
  routeRequest = async (input, init) => {
    await Promise.resolve();
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== API_ORIGIN) {
      state.unexpected.push(`${request.method} ${url.href}`);
      return Response.json({}, { status: 404 });
    }
    if (
      request.method === "GET" &&
      url.pathname === `/v1/chat/threads/${THREAD_ID}/messages`
    ) {
      return Response.json({
        activeSkill: null,
        activeTurnId: null,
        attachedFiles: { fileCount: 0, files: [] },
        context: null,
        contextMatterIds: [],
        forkProvenance: { type: "none" },
        lastActivityAt: state.stored.at(-1)?.createdAt ?? null,
        messages: state.stored,
        model: null,
        olderCursor: null,
        reasoningEffort: null,
        threadExists: state.revision > 0,
        threadRevision:
          state.revision === 0 ? null : `revision-${String(state.revision)}`,
        usedAnonymization: false,
        webSearchAvailable: false,
        webSearchEnabled: false,
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat") {
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return panic("The page posted a chat request without a JSON body");
      }
      const posted = Object.fromEntries(Object.entries(body));
      state.posted.push(posted);
      state.revision += 1;
      if (!state.connected) {
        return Response.json(
          {
            code: CHAT_LOCAL_RUN_REFUSAL.noComputer,
            message: "None of your computers is connected.",
          },
          { status: 409 },
        );
      }
      const holdsMessage = state.stored.some(({ id }) => id === REFUSED_ID);
      if (intentOf(posted) === CHAT_TURN_INTENT.regenerate && !holdsMessage) {
        return Response.json(
          { message: "Truncation target was not found in the chat thread" },
          { status: 400 },
        );
      }
      state.stored = [
        ...state.stored,
        ...(holdsMessage ? [] : [stored(REFUSED_ID, "user", REFUSED_TEXT)]),
        stored(ANSWER_ID, "assistant", ANSWER),
      ];
      const runId = posted["runId"];
      const events = [
        { type: "RUN_STARTED", runId, threadId: THREAD_ID, timestamp: 1 },
        {
          type: "TEXT_MESSAGE_START",
          messageId: ANSWER_ID,
          role: "assistant",
          timestamp: 2,
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: ANSWER_ID,
          delta: ANSWER,
          timestamp: 3,
        },
        { type: "TEXT_MESSAGE_END", messageId: ANSWER_ID, timestamp: 4 },
        {
          type: "RUN_FINISHED",
          runId,
          threadId: THREAD_ID,
          finishReason: "stop",
          timestamp: 5,
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: {
            "content-type": "text/event-stream",
            [CHAT_TURN_ID_HEADER]: TURN_ID,
          },
        },
      );
    }
    state.unexpected.push(`${request.method} ${url.pathname}`);
    return Response.json({ message: "Not served" }, { status: 404 });
  };
  return state;
};

const forwardedPropsOf = (posted: Record<string, unknown> | undefined) => {
  const props = posted?.["forwardedProps"];
  return typeof props === "object" && props !== null
    ? Object.fromEntries(Object.entries(props))
    : {};
};
const intentOf = (posted: Record<string, unknown> | undefined): unknown =>
  forwardedPropsOf(posted)["turnIntent"];
const messageIdOf = (posted: Record<string, unknown> | undefined): unknown => {
  const message = forwardedPropsOf(posted)["message"];
  return typeof message === "object" && message !== null && "id" in message
    ? message.id
    : undefined;
};

type Page = Awaited<ReturnType<typeof openChatThreadDomPage>>;

/** The revision of the thread the page last read. */
const revisionRead = ({ queryClient }: Page): unknown =>
  queryClient
    .getQueryCache()
    .findAll({ queryKey: chatKeys.all })
    .map(({ state }): unknown => state.data)
    .flatMap((data) =>
      typeof data === "object" && data !== null && "threadRevision" in data
        ? [data.threadRevision]
        : [],
    )
    .at(0);

/** The page once the read that follows a refused send has landed. */
const refusalShown = async (server: Server, page: Page) => {
  const { container } = page.view;
  await waitFor(() => {
    if (within(container).queryByText(NO_COMPUTER) === null) {
      panic("The refusal is not shown yet");
    }
  });
  // The fixture reaches the boundary: the thread has moved on from the read
  // the page was built on, stores nothing of the refused send, and the page
  // has read it again.
  expect(server.stored.some(({ id }) => id === REFUSED_ID)).toBe(false);
  const moved = `revision-${String(server.revision)}`;
  await waitFor(() => {
    if (revisionRead(page) !== moved) {
      panic("The page has not read the thread again yet");
    }
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const expectMessageAndRefusal = (container: HTMLElement) => {
  const page = within(container);
  expect(page.getByText(REFUSED_TEXT)).toBeDefined();
  expect(page.getByText(NO_COMPUTER)).toBeDefined();
  expect(
    page.getByRole("button", {
      name: messages.settings.account.desktopOpenApp,
    }),
  ).toBeDefined();
  expect(
    page.getByRole("button", { name: messages.chat.resend }),
  ).toBeDefined();
};

test("the first send of a new chat, refused because no computer is connected, keeps the message and the reason", async () => {
  const server = serve([]);
  const page = await openChatThreadDomPage({
    organizationId: ORGANIZATION_ID,
    threadId: THREAD_ID,
    routeHandoff: {
      content: REFUSED_TEXT,
      id: toSafeId<"chatMessage">(REFUSED_ID),
    },
  });

  await refusalShown(server, page);

  expectMessageAndRefusal(page.view.container);
  expect(server.unexpected).toEqual([]);
});

test("Resend on a send refused because no computer is connected sends the message again, and it is answered", async () => {
  const server = serve([
    stored(FIRST_ID, "user", "First question"),
    stored(FIRST_ANSWER_ID, "assistant", "First answer."),
  ]);
  const live = await openChatThreadDomPage({
    organizationId: ORGANIZATION_ID,
    threadId: THREAD_ID,
  });
  await act(async () => {
    await live.session().sendMessage({
      content: REFUSED_TEXT,
      id: toSafeId<"chatMessage">(REFUSED_ID),
    });
  });
  const { container } = live.view;
  await refusalShown(server, live);
  expectMessageAndRefusal(container);

  server.connected = true;
  await act(async () => {
    fireEvent.click(
      within(container).getByRole("button", { name: messages.chat.resend }),
    );
  });
  await waitFor(() => {
    if (within(container).queryByText(ANSWER) === null) {
      panic("The resent message is not answered yet");
    }
  });

  // The same message, sent as the new message it still is.
  expect(server.posted.map(messageIdOf)).toEqual([REFUSED_ID, REFUSED_ID]);
  expect(server.posted.map(intentOf)).toEqual([undefined, undefined]);
  const page = within(container);
  expect(page.queryByText(NO_COMPUTER)).toBeNull();
  expect(page.queryByText(messages.errors.api.validation)).toBeNull();
  expect(page.getAllByText(REFUSED_TEXT)).toHaveLength(1);
  expect(page.getByText("First answer.")).toBeDefined();
  expect(server.unexpected).toEqual([]);
});
