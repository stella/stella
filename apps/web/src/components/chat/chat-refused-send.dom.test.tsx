import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER, CHAT_TURN_INTENT } from "@stll/api-contract";
import { CHAT_LOCAL_RUN_REFUSAL } from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatEditorController } from "@/components/chat-editor-provider";

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
const { cleanup, waitFor, within } = await import("@testing-library/react");
const { openChatThreadDomPage } =
  await import("@/components/chat/chat-thread-dom-page");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/chat-runtime-registry");
const { CHAT_SEND_KEPT, CHAT_SEND_SENT, useChatEditor } =
  await import("@/components/chat-editor-provider");
const { toSafeId } = await import("@/lib/safe-id");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { EditorContent } = await import("@tiptap/react");
const { useExternalSyncEffect } = await import("@/hooks/use-effect");

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
 * The API as a chat on the member's computer meets it. While the
 * organization does not allow the chosen permissions (`allowed` is false) a
 * send is refused before anything of it is stored, though the request has
 * touched the thread's row by then (the first send of an empty thread titles
 * it), so the next read carries a new revision. A regeneration is taken only
 * for a message the thread stores.
 */
type Server = {
  allowed: boolean;
  stored: StoredMessage[];
  revision: number;
  posted: Record<string, unknown>[];
  unexpected: string[];
};

const serve = (history: StoredMessage[]) => {
  const state: Server = {
    allowed: false,
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
    // Nothing is queued in the chat; a thread the server does not store
    // has no queue either.
    if (
      request.method === "GET" &&
      url.pathname === `/v1/chat/threads/${THREAD_ID}/queue`
    ) {
      return Response.json({ hold: null, items: [] });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat") {
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return panic("The page posted a chat request without a JSON body");
      }
      const posted = Object.fromEntries(Object.entries(body));
      state.posted.push(posted);
      state.revision += 1;
      if (!state.allowed) {
        return Response.json(
          {
            code: CHAT_LOCAL_RUN_REFUSAL.approvalsAboveLimit,
            message: "The organization does not allow these permissions.",
          },
          { status: 403 },
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
    ? Object.fromEntries<unknown>(Object.entries(props))
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

/** The chat's main composer, as the thread page mounts it. */
const Composer = ({
  onController,
}: {
  onController: (controller: ChatEditorController) => void;
}) => {
  const controller = useChatEditor({
    threadRef: { scope: "global", threadId: toChatThreadId(THREAD_ID) },
  });
  useExternalSyncEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return <EditorContent editor={controller.editor} />;
};

test("the first message of a new chat, refused before it is stored, goes back into the chat's composer, and is answered when sent again", async () => {
  const server = serve([]);
  let composer: ChatEditorController | undefined;
  const page = await openChatThreadDomPage({
    organizationId: ORGANIZATION_ID,
    renderComposer: () => (
      <Composer
        onController={(controller) => {
          composer = controller;
        }}
      />
    ),
    threadId: THREAD_ID,
    routeHandoff: {
      content: REFUSED_TEXT,
      id: toSafeId<"chatMessage">(REFUSED_ID),
    },
  });
  const composerText = () => composer?.editor?.getText() ?? "";

  // Sent from the landing page before this page existed, refused before
  // anything of it was stored: the composer holds it, the transcript does
  // not.
  await waitFor(() => {
    if (composerText() !== REFUSED_TEXT) {
      panic("The refused message is not back in the composer yet");
    }
  });
  const { container } = page.view;
  const shownIds = () => page.session().messages.map(({ id }) => id);
  await waitFor(() => {
    if (shownIds().includes(REFUSED_ID)) {
      panic("The refused message still shows in the transcript");
    }
  });
  expect(server.stored).toEqual([]);
  expect(server.posted.map(messageIdOf)).toEqual([REFUSED_ID]);

  server.allowed = true;
  let outcome: unknown;
  await act(async () => {
    outcome = await page.session().sendMessage({
      content: REFUSED_TEXT,
      id: toSafeId<"chatMessage">(REFUSED_ID),
    });
  });
  expect(outcome).toEqual(CHAT_SEND_SENT);
  await waitFor(() => {
    if (within(container).queryByText(ANSWER) === null) {
      panic("The message sent again is not answered yet");
    }
  });
  expect(server.posted.map(intentOf)).toEqual([undefined, undefined]);
  expect(shownIds()).toEqual([REFUSED_ID, ANSWER_ID]);
  expect(server.unexpected).toEqual([]);
});

test("a send refused before it is stored leaves the page for the composer, and is answered when sent again", async () => {
  const server = serve([
    stored(FIRST_ID, "user", "First question"),
    stored(FIRST_ANSWER_ID, "assistant", "First answer."),
  ]);
  const live = await openChatThreadDomPage({
    organizationId: ORGANIZATION_ID,
    threadId: THREAD_ID,
  });
  const send = async () => {
    let outcome: unknown;
    await act(async () => {
      outcome = await live.session().sendMessage({
        content: REFUSED_TEXT,
        id: toSafeId<"chatMessage">(REFUSED_ID),
      });
    });
    return outcome;
  };

  // Refused before anything of it was stored: the composer keeps the draft
  // (the send answers kept), and the page shows the thread as stored.
  expect(await send()).toEqual(CHAT_SEND_KEPT);
  const { container } = live.view;
  expect(server.stored.some(({ id }) => id === REFUSED_ID)).toBe(false);
  await waitFor(() => {
    if (within(container).queryByText(REFUSED_TEXT) !== null) {
      panic("The refused message still shows in the transcript");
    }
  });

  server.allowed = true;
  expect(await send()).toEqual(CHAT_SEND_SENT);
  await waitFor(() => {
    if (within(container).queryByText(ANSWER) === null) {
      panic("The message sent again is not answered yet");
    }
  });
  // The same message, sent as the new message it still is.
  expect(server.posted.map(messageIdOf)).toEqual([REFUSED_ID, REFUSED_ID]);
  expect(server.posted.map(intentOf)).toEqual([undefined, undefined]);
  const page = within(container);
  expect(page.getAllByText(REFUSED_TEXT)).toHaveLength(1);
  expect(page.getByText("First answer.")).toBeDefined();
  expect(server.unexpected).toEqual([]);
});
