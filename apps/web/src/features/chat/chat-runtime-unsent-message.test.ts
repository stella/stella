import { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_TURN_ID_HEADER, CHAT_TURN_INTENT } from "@stll/api-contract";
import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "@stll/api-contract/chat-local-run-question";
import { CHAT_LOCAL_RUN_REFUSAL } from "@stll/api-contract/chat-run-target";

import { openMemberWaitKeys } from "@/components/chat/chat-ui-tools";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  __resetChatRequestStateForTests,
  acquireChatRuntime,
  resendLatestChatMessage,
} from "@/features/chat/chat-runtime-registry";
import { chatThreadOptions } from "@/features/chat/queries";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { chatRefusal } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

const previousFetch = globalThis.fetch;
beforeEach(() => {
  __resetChatRequestStateForTests();
});
afterEach(() => {
  globalThis.fetch = previousFetch;
});

const THREAD_ID = "00000000-0000-7000-8000-0000000000b1";
const threadRef = {
  scope: "global",
  threadId: toChatThreadId(THREAD_ID),
} as const;
const activeOrganizationId = "00000000-0000-7000-8000-00000000ffff";
const context = { allowMissingThread: true };
const TURN_ID = "00000000-0000-7000-8000-0000000000b2";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000c1";
const ANSWER_ID = "00000000-0000-7000-8000-0000000000c2";
const TEXT = "Which leases end this year?";
const ANSWER = "Two of them.";

/** How the server answers a send it does not accept. */
type Refusal =
  { type: "refused"; status: number; code: string } | { type: "unreachable" };

const REFUSALS: { name: string; refusal: Refusal }[] = [
  {
    name: "no computer is connected",
    refusal: {
      type: "refused",
      status: 409,
      code: CHAT_LOCAL_RUN_REFUSAL.noComputer,
    },
  },
  {
    name: "the request is rejected",
    refusal: { type: "refused", status: 422, code: "validation_error" },
  },
  { name: "the server cannot be reached", refusal: { type: "unreachable" } },
];

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  parts: { type: "text"; content: string }[];
  metadata: Record<string, unknown>;
  createdAt: string;
  edited: boolean;
  revision: number;
};

const storedMessage = (
  id: string,
  role: StoredMessage["role"],
  content: string,
): StoredMessage => ({
  id,
  role,
  parts: [{ type: "text", content }],
  metadata: {},
  createdAt: "2026-01-01T00:00:10.000Z",
  edited: false,
  revision: 0,
});

/**
 * The API as a send meets it. A send is refused while `refusal` is set, before
 * anything of it is stored. Like the API, it takes a regeneration only for a
 * message it stores, stores a new message once, and moves the thread's
 * revision whenever a request touches the thread's row.
 */
type Server = {
  refusal: Refusal | null;
  stored: StoredMessage[];
  revision: number;
  /** Whether reads of the thread fail. */
  readsFail: boolean;
  /** Holds every read of the thread until it settles. */
  readsWait: Promise<undefined> | null;
  posted: Record<string, unknown>[];
};

const serve = (initial: Refusal | null) => {
  const state: Server = {
    refusal: initial,
    stored: [],
    revision: 0,
    readsFail: false,
    readsWait: null,
    posted: [],
  };
  const page = () => ({
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
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname.endsWith("/messages")) {
        await state.readsWait;
        return state.readsFail
          ? Response.json({ message: "Unavailable" }, { status: 503 })
          : Response.json(page());
      }
      if (request.method !== "POST" || !pathname.endsWith("/chat")) {
        return Response.json({ message: "Not served" }, { status: 404 });
      }
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new TypeError("Expected a chat request body");
      }
      const posted = Object.fromEntries(Object.entries(body));
      state.posted.push(posted);
      // The send reaches the thread's row before it is routed.
      state.revision += 1;
      const { refusal } = state;
      if (refusal !== null) {
        switch (refusal.type) {
          case "unreachable":
            throw new TypeError("Failed to fetch");
          case "refused":
            return Response.json(
              { code: refusal.code, message: "Refused" },
              { status: refusal.status },
            );
          default:
            refusal satisfies never;
        }
      }
      const holdsMessage = state.stored.some(({ id }) => id === MESSAGE_ID);
      if (intentOf(posted) === CHAT_TURN_INTENT.regenerate && !holdsMessage) {
        return Response.json(
          { message: "Truncation target was not found in the chat thread" },
          { status: 400 },
        );
      }
      state.stored = [
        ...state.stored.filter(({ id }) => id !== ANSWER_ID),
        ...(holdsMessage ? [] : [storedMessage(MESSAGE_ID, "user", TEXT)]),
        storedMessage(ANSWER_ID, "assistant", ANSWER),
      ];
      const runId = posted["runId"];
      const events = [
        { type: "RUN_STARTED", runId, threadId: THREAD_ID },
        { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: ANSWER_ID, delta: ANSWER },
        { type: "TEXT_MESSAGE_END", messageId: ANSWER_ID },
        {
          type: "RUN_FINISHED",
          runId,
          threadId: THREAD_ID,
          finishReason: "stop",
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: {
            "Content-Type": "text/event-stream",
            [CHAT_TURN_ID_HEADER]: TURN_ID,
          },
        },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
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

const textOf = (messages: readonly PersistedChatMessage[]) =>
  messages.map(({ role, parts }) => ({
    role,
    text: parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join(""),
  }));

/** A page on the thread whose first send the server answered as `serve` does. */
const sendOnce = async (server: ReturnType<typeof serve>) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const readThread = async () =>
    await queryClient.query({
      ...chatThreadOptions({ activeOrganizationId, context, key: threadRef }),
      staleTime: 0,
    });
  const acquire = async () =>
    acquireChatRuntime({
      activeOrganizationId,
      context,
      data: await readThread(),
      key: threadRef,
      queryClient,
    });
  const runtime = await acquire();
  const started = await runtime.startRouteHandoffMessage({
    content: TEXT,
    id: toSafeId<"chatMessage">(MESSAGE_ID),
  });
  await Result.tryPromise(async () => await started.stream);
  return { acquire, runtime, server };
};

describe.each(REFUSALS)("a send refused because $name", ({ refusal }) => {
  test("keeps the message and the reason when the thread read after it differs", async () => {
    const { acquire, runtime, server } = await sendOnce(serve(refusal));
    const refused = runtime.getSnapshot();
    expect(refused.status).toBe("error");
    expect(textOf(refused.messages).at(0)).toEqual({
      role: "user",
      text: TEXT,
    });
    // The fixture reaches the boundary: the read after the refusal is not
    // the one the runtime was built on, and holds nothing of the send.
    expect(server.revision).toBe(1);
    expect(server.stored).toEqual([]);

    expect(await acquire()).toBe(runtime);
    // Acknowledged: a later render on the same read keeps it too.
    expect(await acquire()).toBe(runtime);
    expect(runtime.getSnapshot().error).toBe(refused.error);
    expect(textOf(runtime.getSnapshot().messages).at(0)).toEqual({
      role: "user",
      text: TEXT,
    });
  });

  test("goes out again as the same new message, and is answered", async () => {
    const { acquire, runtime, server } = await sendOnce(serve(refusal));
    await acquire();
    server.refusal = null;

    await resendLatestChatMessage(runtime);

    expect(server.posted).toHaveLength(2);
    expect(messageIdOf(server.posted.at(1))).toBe(MESSAGE_ID);
    expect(intentOf(server.posted.at(1))).toBeUndefined();
    expect(runtime.getSnapshot().error).toBeUndefined();
    expect(textOf(runtime.getSnapshot().messages)).toEqual([
      { role: "user", text: TEXT },
      { role: "assistant", text: ANSWER },
    ]);
    // Once the thread read holds the turn, the page shows it as stored.
    const stored = await acquire();
    expect(stored).not.toBe(runtime);
    expect(textOf(stored.getSnapshot().messages)).toEqual([
      { role: "user", text: TEXT },
      { role: "assistant", text: ANSWER },
    ]);
  });
});

test("a refused send the member's computer still cannot take keeps the message through every resend", async () => {
  const { acquire, runtime, server } = await sendOnce(
    serve({
      type: "refused",
      status: 409,
      code: CHAT_LOCAL_RUN_REFUSAL.noComputer,
    }),
  );
  await acquire();

  await resendLatestChatMessage(runtime);

  expect(server.posted.map(intentOf)).toEqual([undefined, undefined]);
  expect(await acquire()).toBe(runtime);
  expect(chatRefusal(runtime.getSnapshot().error)).toMatchObject({
    status: 409,
    code: CHAT_LOCAL_RUN_REFUSAL.noComputer,
  });
  expect(textOf(runtime.getSnapshot().messages).at(0)).toEqual({
    role: "user",
    text: TEXT,
  });
});

test("a turn the server accepted is regenerated, and its stored turn replaces the page's", async () => {
  const { acquire, runtime, server } = await sendOnce(serve(null));
  expect(server.stored.map(({ id }) => id)).toEqual([MESSAGE_ID, ANSWER_ID]);

  await resendLatestChatMessage(runtime);

  expect(server.posted.map(intentOf)).toEqual([
    undefined,
    CHAT_TURN_INTENT.regenerate,
  ]);
  expect(await acquire()).not.toBe(runtime);
});

test("a resend whose thread cannot be read stays a regeneration", async () => {
  const { runtime, server } = await sendOnce(
    serve({ type: "refused", status: 422, code: "validation_error" }),
  );
  server.refusal = null;
  server.readsFail = true;

  await resendLatestChatMessage(runtime);

  expect(server.posted.map(intentOf)).toEqual([
    undefined,
    CHAT_TURN_INTENT.regenerate,
  ]);
  // Refused, as the server stores no such message; what the member wrote
  // is still on the page.
  expect(chatRefusal(runtime.getSnapshot().error)).toMatchObject({
    status: 400,
  });
  expect(textOf(runtime.getSnapshot().messages).at(0)).toEqual({
    role: "user",
    text: TEXT,
  });
});

test("a kept unsent message follows what another tab stored in the thread meanwhile", async () => {
  const { acquire, runtime, server } = await sendOnce(
    serve({
      type: "refused",
      status: 409,
      code: CHAT_LOCAL_RUN_REFUSAL.noComputer,
    }),
  );
  const refused = runtime.getSnapshot().error;
  server.stored = [
    storedMessage("00000000-0000-7000-8000-0000000000d1", "user", "Elsewhere"),
    storedMessage(
      "00000000-0000-7000-8000-0000000000d2",
      "assistant",
      "Answered elsewhere.",
    ),
  ];
  server.revision += 1;

  expect(await acquire()).toBe(runtime);
  await Promise.resolve();

  // The stored thread, then the message still to send, with its reason.
  expect(textOf(runtime.getSnapshot().messages)).toEqual([
    { role: "user", text: "Elsewhere" },
    { role: "assistant", text: "Answered elsewhere." },
    { role: "user", text: TEXT },
  ]);
  expect(runtime.getSnapshot().error).toBe(refused);

  server.refusal = null;
  await resendLatestChatMessage(runtime);

  expect(intentOf(server.posted.at(1))).toBeUndefined();
  expect(textOf(runtime.getSnapshot().messages)).toEqual([
    { role: "user", text: "Elsewhere" },
    { role: "assistant", text: "Answered elsewhere." },
    { role: "user", text: TEXT },
    { role: "assistant", text: ANSWER },
  ]);
});

test("a resend leaves the turn to a message sent while the thread was read", async () => {
  const { runtime, server } = await sendOnce(
    serve({
      type: "refused",
      status: 409,
      code: CHAT_LOCAL_RUN_REFUSAL.noComputer,
    }),
  );
  server.refusal = null;
  const read = Promise.withResolvers<undefined>();
  server.readsWait = read.promise;

  const resend = resendLatestChatMessage(runtime);
  const newer = await runtime.startRouteHandoffMessage({
    content: "Never mind, list them all.",
    id: toSafeId<"chatMessage">("00000000-0000-7000-8000-0000000000f1"),
  });
  await newer.stream;
  read.resolve(undefined);
  await resend;

  // Only the refused send and the newer message were posted.
  expect(server.posted).toHaveLength(2);
  expect(intentOf(server.posted.at(1))).toBeUndefined();
});

// --- An unsent message and something open for the member ------------------

const WAIT_CALL_ID = "tool-wait";
const FIRST_ID = "00000000-0000-7000-8000-0000000000e1";
const FIRST_ANSWER_ID = "00000000-0000-7000-8000-0000000000e2";

type OpenWait = {
  name: string;
  toolName: string;
  interrupt: (runId: unknown) => Record<string, unknown>;
  /** The keys the paused turn has open for the member. */
  keys: string[];
};

const QUESTION_INTERRUPT_ID = "00000000-0000-7000-8000-0000000000a1";

const OPEN_WAITS: OpenWait[] = [
  {
    name: "an approval",
    toolName: "web_search",
    interrupt: (runId) => ({
      id: `approval_${WAIT_CALL_ID}`,
      reason: "tool_call",
      toolCallId: WAIT_CALL_ID,
      metadata: {
        kind: "approval",
        toolName: "web_search",
        input: {},
        "tanstack:interruptBinding": {
          v: 1,
          kind: "tool-approval",
          interruptId: `approval_${WAIT_CALL_ID}`,
          interruptedRunId: runId,
          generation: 0,
          toolName: "web_search",
          toolCallId: WAIT_CALL_ID,
          originalArgs: {},
          inputSchemaHash: "server-owned",
          approvalSchemaHash: "server-owned",
          responseSchemaHash: "server-owned",
        },
      },
    }),
    keys: [`part:${WAIT_CALL_ID}`],
  },
  {
    name: "a coding agent's question",
    toolName: CHAT_LOCAL_RUN_QUESTION_TOOL,
    interrupt: () => ({
      id: QUESTION_INTERRUPT_ID,
      reason: "user_input",
      message: "Which law governs the lease?",
      toolCallId: WAIT_CALL_ID,
      metadata: {
        kind: "question",
        toolName: CHAT_LOCAL_RUN_QUESTION_TOOL,
        questions: [
          {
            id: "law",
            header: "Governing law",
            prompt: "Which law governs the lease?",
            options: [{ label: "Czech", description: "" }],
            allowsFreeText: false,
            multiSelect: false,
            secret: false,
          },
        ],
      },
    }),
    keys: [`part:${WAIT_CALL_ID}`, `interrupt:${QUESTION_INTERRUPT_ID}`],
  },
];

/** A run that pauses its turn on `wait`. */
const pausedRun = (wait: OpenWait, runId: unknown) => [
  { type: "RUN_STARTED", runId, threadId: THREAD_ID },
  { type: "TEXT_MESSAGE_START", messageId: FIRST_ANSWER_ID, role: "assistant" },
  {
    type: "TOOL_CALL_START",
    parentMessageId: FIRST_ANSWER_ID,
    toolCallId: WAIT_CALL_ID,
    toolCallName: wait.toolName,
    toolName: wait.toolName,
  },
  { type: "TOOL_CALL_ARGS", delta: "{}", toolCallId: WAIT_CALL_ID },
  {
    type: "TOOL_CALL_END",
    input: {},
    toolCallId: WAIT_CALL_ID,
    toolCallName: wait.toolName,
    toolName: wait.toolName,
  },
  {
    type: "RUN_FINISHED",
    runId,
    threadId: THREAD_ID,
    finishReason: "tool_calls",
    outcome: { type: "interrupt", interrupts: [wait.interrupt(runId)] },
  },
];

test.each(OPEN_WAITS)(
  "a message refused while $name was open is kept, though the thread no longer holds that wait",
  async (wait) => {
    // The first send pauses on the wait; every later send is refused. The
    // stored thread is what another device left: the wait answered there.
    const elsewhere = [
      storedMessage(FIRST_ID, "user", "Search for it"),
      storedMessage(FIRST_ANSWER_ID, "assistant", "Answered elsewhere."),
    ];
    let posts = 0;
    let stored: StoredMessage[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          return Response.json({
            activeSkill: null,
            activeTurnId: null,
            attachedFiles: { fileCount: 0, files: [] },
            context: null,
            contextMatterIds: [],
            forkProvenance: { type: "none" },
            lastActivityAt: stored.at(-1)?.createdAt ?? null,
            messages: stored,
            model: null,
            olderCursor: null,
            reasoningEffort: null,
            threadExists: stored.length > 0,
            threadRevision: stored.length === 0 ? null : "revision-elsewhere",
            usedAnonymization: false,
            webSearchAvailable: false,
            webSearchEnabled: false,
          });
        }
        posts += 1;
        if (posts > 1) {
          return Response.json(
            { code: CHAT_LOCAL_RUN_REFUSAL.noComputer, message: "Refused" },
            { status: 409 },
          );
        }
        const body: unknown = await request.json();
        const runId =
          typeof body === "object" && body !== null && "runId" in body
            ? body.runId
            : undefined;
        return new Response(
          pausedRun(wait, runId)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
      { preconnect: previousFetch.preconnect },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const acquire = async () =>
      acquireChatRuntime({
        activeOrganizationId,
        context,
        data: await queryClient.query({
          ...chatThreadOptions({
            activeOrganizationId,
            context,
            key: threadRef,
          }),
          staleTime: 0,
        }),
        key: threadRef,
        queryClient,
      });
    const runtime = await acquire();
    const first = await runtime.startRouteHandoffMessage({
      content: "Search for it",
      id: toSafeId<"chatMessage">(FIRST_ID),
    });
    await first.stream;
    const waiting = runtime.getSnapshot();
    expect(
      openMemberWaitKeys({
        localRunQuestion: waiting.localRunQuestion,
        messages: waiting.messages,
      }),
    ).toEqual(wait.keys);

    const second = await runtime.startRouteHandoffMessage({
      content: TEXT,
      id: toSafeId<"chatMessage">(MESSAGE_ID),
    });
    await Result.tryPromise(async () => await second.stream);
    const refused = runtime.getSnapshot();
    expect(refused.status).toBe("error");
    // The new message superseded the wait: nothing is open any more, so only
    // the unsent message can keep the runtime.
    expect(
      openMemberWaitKeys({
        localRunQuestion: refused.localRunQuestion,
        messages: refused.messages,
      }),
    ).toEqual([]);

    stored = elsewhere;
    expect(await acquire()).toBe(runtime);
    await Promise.resolve();

    expect(runtime.getSnapshot().error).toBe(refused.error);
    expect(textOf(runtime.getSnapshot().messages)).toEqual([
      { role: "user", text: "Search for it" },
      { role: "assistant", text: "Answered elsewhere." },
      { role: "user", text: TEXT },
    ]);
  },
);
