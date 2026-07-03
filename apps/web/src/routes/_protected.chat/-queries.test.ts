import { replaceEqualDeep } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId, type SafeId } from "@/lib/safe-id";
import {
  __resetChatRequestStateForTests,
  buildSendRequestBody,
  chatKeys,
  chatThreadOptions,
  createChatRuntime,
  matchesChatThreadAcrossScopes,
  mergeGroupedChatThreadPages,
  sendThreadChatMessage,
} from "@/routes/_protected.chat/-queries";

const createMessage = (id = "message-A"): PersistedChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content: "Hello" }],
});
const date = (value: string): Date => new Date(value);
const assistantMessageId = "11111111-1111-4111-8111-111111111111";
const createOutgoingMessage = (
  id: string,
  content = "ahoj",
): { content: string; id: SafeId<"chatMessage"> } => ({
  id: toSafeId<"chatMessage">(id),
  content,
});

const createSseResponse = (chunks: readonly Record<string, unknown>[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

const parseJsonRequestBody = (init: RequestInit | undefined): unknown => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected chat fetch body to be a JSON string");
  }
  return JSON.parse(init.body);
};

describe("chatKeys", () => {
  test("separates plain chat transports from active DOCX edit transports", () => {
    const threadId = toChatThreadId("thread-A");
    const base = {
      allowMissingThread: true,
      scope: "workspace",
      threadId,
      workspaceId: "ws-1",
    } as const;

    expect(chatKeys.thread("org_test", base)).toEqual(
      chatKeys.thread("org_test", { ...base, contextKind: "plain" }),
    );
    expect(
      chatKeys.thread("org_test", { ...base, contextKind: "plain" }),
    ).not.toEqual(
      chatKeys.thread("org_test", { ...base, contextKind: "active-docx-edit" }),
    );
  });

  test("shares the draft chat runtime key with the routed thread page", () => {
    const threadId = toChatThreadId("thread-A");
    const threadRef = { scope: "global", threadId } as const;
    const activeOrganizationId = "org_test";

    const draftOptions = chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: {
        allowMissingThread: true,
        getContextMatterIds: () => ["matter-A"],
        getSendMode: () => CHAT_SEND_MODE.anonymized,
        getUserContext: () => ({
          locale: "cs",
          timezone: "Europe/Prague",
          userName: "Test User",
          wordEditAuthorName: "Test User",
          wordEditShortcut: "TU",
        }),
      },
    });
    const routedOptions = chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: {
        allowMissingThread: true,
        getContextMatterIds: () => [],
        getSendMode: () => CHAT_SEND_MODE.rawOverride,
        getUserContext: () => ({
          locale: "en",
          timezone: "UTC",
          userName: "Route User",
          wordEditAuthorName: "Route User",
          wordEditShortcut: "RU",
        }),
      },
    });

    expect(draftOptions.queryKey).toEqual(routedOptions.queryKey);
  });
});

describe("matchesChatThreadAcrossScopes", () => {
  const threadId = toChatThreadId("thread-A");
  const otherThreadId = toChatThreadId("thread-B");

  test("matches the global scope's key for the same thread", () => {
    const key = chatKeys.thread("org_test", { scope: "global", threadId });
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("matches the workspace scope's key for the same thread", () => {
    const key = chatKeys.thread("org_test", {
      scope: "workspace",
      workspaceId: "ws-1",
      threadId,
    });
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("rejects keys for other threads", () => {
    expect(
      matchesChatThreadAcrossScopes(
        chatKeys.thread("org_test", {
          scope: "global",
          threadId: otherThreadId,
        }),
        threadId,
      ),
    ).toBe(false);
    expect(
      matchesChatThreadAcrossScopes(
        chatKeys.thread("org_test", {
          scope: "workspace",
          workspaceId: "ws-1",
          threadId: otherThreadId,
        }),
        threadId,
      ),
    ).toBe(false);
  });

  test("rejects non-chat keys", () => {
    expect(
      matchesChatThreadAcrossScopes(
        ["entities", "thread", "global", threadId],
        threadId,
      ),
    ).toBe(false);
    expect(
      matchesChatThreadAcrossScopes(["chat", "threads", "global"], threadId),
    ).toBe(false);
  });

  test("rejects keys with an unrecognised scope", () => {
    expect(
      matchesChatThreadAcrossScopes(
        ["chat", "thread", "elsewhere", threadId],
        threadId,
      ),
    ).toBe(false);
  });
});

describe("mergeGroupedChatThreadPages", () => {
  test("deduplicates threads while appending workspace groups across pages", () => {
    const result = mergeGroupedChatThreadPages([
      {
        global: [
          {
            createdAt: date("2026-05-16T08:00:00.000Z"),
            id: "global-A",
            title: "Global A",
            updatedAt: date("2026-05-16T08:00:00.000Z"),
          },
        ],
        nextCursor: "page-2",
        workspaces: [
          {
            workspaceId: "workspace-A",
            workspaceName: "Matter A",
            threads: [
              {
                createdAt: date("2026-05-16T07:00:00.000Z"),
                id: "workspace-thread-A",
                title: "Workspace A",
                updatedAt: date("2026-05-16T07:00:00.000Z"),
              },
            ],
          },
        ],
      },
      {
        global: [
          {
            createdAt: date("2026-05-16T08:00:00.000Z"),
            id: "global-A",
            title: "Global A duplicate",
            updatedAt: date("2026-05-16T08:00:00.000Z"),
          },
          {
            createdAt: date("2026-05-16T06:00:00.000Z"),
            id: "global-B",
            title: "Global B",
            updatedAt: date("2026-05-16T06:00:00.000Z"),
          },
        ],
        nextCursor: null,
        workspaces: [
          {
            workspaceId: "workspace-A",
            workspaceName: "Matter A",
            threads: [
              {
                createdAt: date("2026-05-16T07:00:00.000Z"),
                id: "workspace-thread-A",
                title: "Workspace A duplicate",
                updatedAt: date("2026-05-16T07:00:00.000Z"),
              },
              {
                createdAt: date("2026-05-16T05:00:00.000Z"),
                id: "workspace-thread-B",
                title: "Workspace B",
                updatedAt: date("2026-05-16T05:00:00.000Z"),
              },
            ],
          },
          {
            workspaceId: "workspace-B",
            workspaceName: "Matter B",
            threads: [
              {
                createdAt: date("2026-05-16T04:00:00.000Z"),
                id: "workspace-thread-C",
                title: "Workspace C",
                updatedAt: date("2026-05-16T04:00:00.000Z"),
              },
            ],
          },
        ],
      },
    ]);

    expect(result.global.map((thread) => thread.id)).toEqual([
      "global-A",
      "global-B",
    ]);
    expect(result.workspaces).toMatchObject([
      {
        workspaceId: "workspace-A",
        threads: [{ id: "workspace-thread-A" }, { id: "workspace-thread-B" }],
      },
      {
        workspaceId: "workspace-B",
        threads: [{ id: "workspace-thread-C" }],
      },
    ]);
  });
});

describe("buildSendRequestBody", () => {
  beforeEach(() => {
    __resetChatRequestStateForTests();
  });

  test("includes the preferred send mode from the chat surface", () => {
    const threadId = toChatThreadId("thread-A");
    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key: { scope: "global", threadId },
        messages: [createMessage()],
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.anonymized,
      threadId: "thread-A",
    });
  });

  test("preserves a raw override across continuation requests in the same turn", () => {
    const threadId = toChatThreadId("thread-A");
    const key = { scope: "global", threadId } as const;

    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key,
        messages: [createMessage()],
        requestBody: { sendMode: CHAT_SEND_MODE.rawOverride },
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId: "thread-A",
    });
    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key,
        messages: [
          createMessage(),
          {
            id: "assistant-A",
            role: "assistant",
            parts: [
              {
                arguments: JSON.stringify({ code: "return entities;" }),
                id: "tool-call-A",
                input: { code: "return entities;" },
                output: { content: [] },
                state: "complete",
                name: "run-stella-query",
                type: "tool-call",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId: "thread-A",
    });
  });

  test("forwards the replay truncation target for tool-result continuations", () => {
    const threadId = toChatThreadId("thread-A");
    const truncateAfterMessageId = toSafeId<"chatMessage">(
      "22222222-2222-4222-8222-222222222222",
    );

    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key: { scope: "global", threadId },
        messages: [createMessage()],
        requestBody: {
          sendMode: CHAT_SEND_MODE.rawOverride,
          truncateAfterMessageId,
        },
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId: "thread-A",
      truncateAfterMessageId,
    });
  });

  test("replaces the remembered send mode when the next user turn starts", () => {
    const threadId = toChatThreadId("thread-A");
    const key = { scope: "global", threadId } as const;

    buildSendRequestBody({
      context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
      key,
      messages: [createMessage("message-A")],
      requestBody: { sendMode: CHAT_SEND_MODE.rawOverride },
    });

    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key,
        messages: [createMessage("message-A"), createMessage("message-B")],
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.anonymized,
      threadId: "thread-A",
    });
  });
});

describe("chat runtime", () => {
  const previousFetch = globalThis.fetch;
  type FetchHandler = (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>;
  const createFetchMock = (handler: FetchHandler): typeof fetch =>
    Object.assign(handler, { preconnect: previousFetch.preconnect });

  beforeEach(() => {
    __resetChatRequestStateForTests();
    globalThis.fetch = previousFetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("streams reasoning and final text through tanstack ChatClient", async () => {
    const threadId = toChatThreadId("thread-A");
    const requests: unknown[] = [];
    let finishCount = 0;

    globalThis.fetch = createFetchMock(async (_input, init) => {
      requests.push(parseJsonRequestBody(init));
      return createSseResponse([
        { type: "RUN_STARTED", threadId, runId: "run-A" },
        {
          type: "TEXT_MESSAGE_START",
          messageId: assistantMessageId,
          role: "assistant",
        },
        {
          type: "REASONING_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "Reading the prompt.",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "Ahoj!",
        },
        { type: "TEXT_MESSAGE_END", messageId: assistantMessageId },
        {
          type: "RUN_FINISHED",
          threadId,
          runId: "run-A",
          finishReason: "stop",
        },
      ]);
    });

    const runtime = createChatRuntime({
      context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
      initialMessages: [],
      key: { scope: "global", threadId },
      onError: (error) => {
        throw error;
      },
      onFinish: () => {
        finishCount += 1;
      },
    });

    await sendThreadChatMessage(
      runtime,
      createOutgoingMessage("22222222-2222-4222-8222-222222222201"),
      {
        body: { sendMode: CHAT_SEND_MODE.rawOverride },
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests.at(0)).toMatchObject({
      message: {
        parts: [{ type: "text", content: "ahoj" }],
        role: "user",
      },
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId,
    });
    expect(finishCount).toBe(1);
    expect(runtime.getSnapshot()).toMatchObject({
      status: "ready",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", content: "ahoj" }],
        },
        {
          id: assistantMessageId,
          role: "assistant",
          parts: [
            { type: "thinking", content: "Reading the prompt." },
            { type: "text", content: "Ahoj!" },
          ],
        },
      ],
    });
  });

  test("streams reasoning-first chunks through tanstack ChatClient", async () => {
    const threadId = toChatThreadId("thread-A");
    let finishCount = 0;

    globalThis.fetch = createFetchMock(async () =>
      createSseResponse([
        { type: "RUN_STARTED", threadId, runId: "run-A" },
        {
          type: "TEXT_MESSAGE_START",
          messageId: assistantMessageId,
          role: "assistant",
        },
        {
          type: "REASONING_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "Thinking before answer.",
        },
        {
          type: "RUN_FINISHED",
          threadId,
          runId: "run-A",
          finishReason: "stop",
        },
      ]),
    );

    const runtime = createChatRuntime({
      context: undefined,
      initialMessages: [],
      key: { scope: "global", threadId },
      onError: (error) => {
        throw error;
      },
      onFinish: () => {
        finishCount += 1;
      },
    });

    await sendThreadChatMessage(
      runtime,
      createOutgoingMessage("22222222-2222-4222-8222-222222222202"),
    );

    expect(finishCount).toBe(1);
    expect(runtime.getSnapshot().messages.at(-1)).toMatchObject({
      id: assistantMessageId,
      role: "assistant",
      parts: [{ type: "thinking", content: "Thinking before answer." }],
    });
  });

  test("notifies subscribers when tanstack ChatClient sendMessage streams", async () => {
    const threadId = toChatThreadId("thread-A");
    const snapshots: PersistedChatMessage[][] = [];

    globalThis.fetch = createFetchMock(async () =>
      createSseResponse([
        { type: "RUN_STARTED", threadId, runId: "run-A" },
        {
          type: "TEXT_MESSAGE_START",
          messageId: assistantMessageId,
          role: "assistant",
        },
        {
          type: "REASONING_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "Checking context.",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "Ahoj!",
        },
        { type: "TEXT_MESSAGE_END", messageId: assistantMessageId },
        {
          type: "RUN_FINISHED",
          threadId,
          runId: "run-A",
          finishReason: "stop",
        },
      ]),
    );

    const runtime = createChatRuntime({
      context: undefined,
      initialMessages: [],
      key: { scope: "global", threadId },
      onError: (error) => {
        throw error;
      },
      onFinish: () => {},
    });
    const unsubscribe = runtime.subscribe(() => {
      snapshots.push(runtime.getSnapshot().messages);
    });

    await sendThreadChatMessage(
      runtime,
      createOutgoingMessage("22222222-2222-4222-8222-222222222203"),
    );
    unsubscribe();

    expect(snapshots.some((messages) => messages.length > 0)).toBe(true);
    expect(snapshots.at(-1)).toMatchObject([
      {
        role: "user",
        parts: [{ type: "text", content: "ahoj" }],
      },
      {
        role: "assistant",
        parts: [
          { type: "thinking", content: "Checking context." },
          { type: "text", content: "Ahoj!" },
        ],
      },
    ]);
  });

  test("exposes mounted-thread messages immediately before the response resolves", async () => {
    const threadId = toChatThreadId("thread-A");
    let markResponseRequested: () => void = () => {
      throw new Error("Chat response was not requested");
    };
    const responseRequested = new Promise<void>((resolve) => {
      markResponseRequested = resolve;
    });
    let releaseResponse: () => void = () => {
      throw new Error("Chat response was not requested");
    };

    globalThis.fetch = createFetchMock(async () => {
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
        markResponseRequested();
      });
      return createSseResponse([
        { type: "RUN_STARTED", threadId, runId: "run-A" },
        {
          type: "TEXT_MESSAGE_START",
          messageId: assistantMessageId,
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "Ahoj!",
        },
        { type: "TEXT_MESSAGE_END", messageId: assistantMessageId },
        {
          type: "RUN_FINISHED",
          threadId,
          runId: "run-A",
          finishReason: "stop",
        },
      ]);
    });

    const runtime = createChatRuntime({
      context: undefined,
      initialMessages: [],
      key: { scope: "global", threadId },
      onError: (error) => {
        throw error;
      },
      onFinish: () => {},
    });
    const message = createOutgoingMessage(
      "22222222-2222-4222-8222-222222222204",
    );

    const sent = sendThreadChatMessage(runtime, message);

    expect(runtime.getSnapshot().messages).toMatchObject([
      {
        id: message.id,
        role: "user",
        parts: [{ type: "text", content: "ahoj" }],
      },
    ]);

    await responseRequested;
    releaseResponse();
    await sent;
  });

  test("exposes the first draft message immediately for the route handoff", async () => {
    const threadId = toChatThreadId("thread-A");
    let markResponseRequested: () => void = () => {
      throw new Error("Chat response was not requested");
    };
    const responseRequested = new Promise<void>((resolve) => {
      markResponseRequested = resolve;
    });
    let releaseResponse: () => void = () => {
      throw new Error("Chat response was not requested");
    };

    globalThis.fetch = createFetchMock(async () => {
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
        markResponseRequested();
      });
      return createSseResponse([
        { type: "RUN_STARTED", threadId, runId: "run-A" },
        {
          type: "TEXT_MESSAGE_START",
          messageId: assistantMessageId,
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "Ahoj!",
        },
        { type: "TEXT_MESSAGE_END", messageId: assistantMessageId },
        {
          type: "RUN_FINISHED",
          threadId,
          runId: "run-A",
          finishReason: "stop",
        },
      ]);
    });

    const runtime = createChatRuntime({
      context: undefined,
      initialMessages: [],
      key: { scope: "global", threadId },
      onError: (error) => {
        throw error;
      },
      onFinish: () => {},
    });

    const messageId = toSafeId<"chatMessage">(
      "22222222-2222-4222-8222-222222222222",
    );
    const started = runtime.startRouteHandoffMessage({
      id: messageId,
      content: "ahoj",
    });

    expect(started.messageId).toBe(messageId);
    expect(runtime.getSnapshot().messages).toMatchObject([
      {
        id: messageId,
        role: "user",
        parts: [{ type: "text", content: "ahoj" }],
      },
    ]);

    await responseRequested;
    releaseResponse();
    await started.stream;
  });
});

describe("chat runtime identity across query refetch", () => {
  // Shape a `ChatThreadFetched`-like value: a live runtime plus the
  // post-turn context estimate that changes every turn. Each queryFn run
  // creates and registers a fresh runtime, so consecutive fetches carry
  // distinct runtime identities.
  const buildFetched = (estimatedTokens: number) => ({
    chat: createChatRuntime({
      context: undefined,
      initialMessages: [],
      key: { scope: "global", threadId: toChatThreadId("thread-shared") },
      onError: () => {},
      onFinish: () => {},
    }),
    olderCursor: null as string | null,
    contextMatterIds: [] as string[],
    lastActivityAt: null as string | null,
    webSearchAvailable: false,
    webSearchEnabled: false,
    context: {
      estimatedTokens,
      triggerTokens: 200_000,
      breakdown: {
        summaryTokens: 0,
        conversationTokens: estimatedTokens,
        attachmentTokens: 0,
      },
    },
  });

  test("structural sharing would strip the runtime's send capability", async () => {
    const prev = buildFetched(100);
    const next = buildFetched(200);

    // This is exactly what TanStack's default structural sharing does on a
    // refetch. Because `context` changed it rebuilds the parent, and because
    // the runtime's method closures differ across runs it rebuilds `chat`
    // into a fresh `{}` copy: neither the previous nor the freshly registered
    // runtime, and (via `Object.keys`) without the runtime's `Symbol` brand.
    const shared = replaceEqualDeep(prev, next);

    expect(shared.chat).not.toBe(prev.chat);
    expect(shared.chat).not.toBe(next.chat);

    // The rebuilt copy was never registered in the send-capability WeakMap,
    // so sending through it panics ("Missing thread send capability"). This
    // is the corruption `chatThreadOptions`' `structuralSharing: false` avoids
    // by handing the registered runtime back verbatim.
    expect(
      sendThreadChatMessage(
        shared.chat,
        createOutgoingMessage("22222222-2222-4222-8222-2222222222aa"),
      ),
    ).rejects.toThrow("Missing thread send capability");
  });

  test("chatThreadOptions opts out of structural sharing", () => {
    const options = chatThreadOptions({
      activeOrganizationId: "org-A",
      key: { scope: "global", threadId: toChatThreadId("thread-opts") },
      context: { allowMissingThread: true },
    });

    // Guards the invariant: the query data embeds a `ChatRuntime` whose
    // identity and `Symbol` brand must survive every refetch, so this query
    // must never run through `replaceEqualDeep`.
    expect(options.structuralSharing).toBe(false);
  });
});
