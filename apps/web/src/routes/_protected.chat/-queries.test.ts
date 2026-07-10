import {
  QueryClient,
  queryOptions,
  replaceEqualDeep,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId, type SafeId } from "@/lib/safe-id";
import {
  __resetChatRequestStateForTests,
  acquireChatRuntime,
  applyChatModelChange,
  buildSendRequestBody,
  chatKeys,
  chatThreadOptions,
  createChatRuntime,
  installChatRuntimeCleanup,
  matchesChatThreadAcrossScopes,
  mergeGroupedChatThreadPages,
  sendThreadChatMessage,
  type ChatThreadFetched,
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

describe("applyChatModelChange", () => {
  const threadId = toChatThreadId("thread-A");

  // Mirrors how `chatThreadOptions`/the draft `/chat` composer's meta query
  // build their own tagged query keys, so `applyChatModelChange`'s
  // `setQueryData` call infers its data type the same way it does for the
  // real callers instead of needing a cast here.
  const buildKey = (scope: "global" | "workspace") =>
    queryOptions({
      queryKey: chatKeys.thread(
        "org_test",
        scope === "global"
          ? { scope: "global", threadId }
          : { scope: "workspace", threadId, workspaceId: "ws-1" },
      ),
      queryFn: async () => ({ model: null as string | null, other: "keep" }),
    }).queryKey;

  test("updates the cache entry's model and invalidates the thread across scopes", () => {
    const queryClient = new QueryClient();
    const globalKey = buildKey("global");
    const workspaceKey = buildKey("workspace");
    queryClient.setQueryData(globalKey, { model: null, other: "keep" });
    queryClient.setQueryData(workspaceKey, { model: null, other: "keep" });

    applyChatModelChange({
      model: "anthropic::claude-x",
      queryClient,
      queryKey: globalKey,
      threadId,
    });

    const updated: unknown = queryClient.getQueryData(globalKey);
    expect(updated).toEqual({
      model: "anthropic::claude-x",
      other: "keep",
    });
    // Every cached entry for the thread is invalidated, not just the one
    // whose cache this call touched directly -- the whole point of routing
    // every composer surface through this one helper.
    expect(queryClient.getQueryState(globalKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(workspaceKey)?.isInvalidated).toBe(true);
  });

  test("leaves a missing cache entry untouched", () => {
    const queryClient = new QueryClient();
    const key = buildKey("global");

    applyChatModelChange({
      model: "anthropic::claude-x",
      queryClient,
      queryKey: key,
      threadId,
    });

    const untouched: unknown = queryClient.getQueryData(key);
    expect(untouched).toBeUndefined();
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
                arguments: JSON.stringify({
                  typescriptCode: "return entities;",
                }),
                id: "tool-call-A",
                input: { typescriptCode: "return entities;" },
                output: { success: true, result: [] },
                state: "complete",
                name: "execute_typescript",
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

    // Guards the known requirement: this query keeps
    // `structuralSharing: false` (each refetch hands back a fresh object;
    // see the option's inline comment for the history and rationale).
    expect(options.structuralSharing).toBe(false);
  });
});

describe("acquireChatRuntime reconcile", () => {
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

  const threadId = toChatThreadId("thread-acquire");
  const threadRef = { scope: "global", threadId } as const;
  const activeOrganizationId = "org_test";

  const buildThreadData = (
    overrides: Partial<ChatThreadFetched> = {},
  ): ChatThreadFetched => ({
    messages: [],
    olderCursor: null,
    contextMatterIds: [],
    lastActivityAt: null,
    webSearchAvailable: false,
    webSearchEnabled: false,
    context: null,
    model: null,
    ...overrides,
  });

  const newerThreadData = () =>
    buildThreadData({
      lastActivityAt: "2026-07-08T10:00:00.000Z",
      messages: [
        createMessage("message-A"),
        {
          id: assistantMessageId,
          role: "assistant",
          parts: [{ type: "text", content: "Ahoj!" }],
        },
      ],
    });

  const createFinishedSseChunks = () => [
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
    { type: "RUN_FINISHED", threadId, runId: "run-A", finishReason: "stop" },
  ];

  test("reattaches to the same runtime when the freshness signal is unchanged", () => {
    const queryClient = new QueryClient();
    const data = buildThreadData();

    const first = acquireChatRuntime({
      activeOrganizationId,
      context: { allowMissingThread: true },
      data,
      key: threadRef,
      queryClient,
    });
    const second = acquireChatRuntime({
      activeOrganizationId,
      context: { allowMissingThread: true },
      data: buildThreadData(),
      key: threadRef,
      queryClient,
    });

    expect(second).toBe(first);
  });

  test("rebuilds an idle runtime from the current caller's live getters when newer data arrives", async () => {
    const queryClient = new QueryClient();
    const requests: unknown[] = [];
    globalThis.fetch = createFetchMock(async (_input, init) => {
      requests.push(parseJsonRequestBody(init));
      return createSseResponse(createFinishedSseChunks());
    });

    const first = acquireChatRuntime({
      activeOrganizationId,
      context: {
        allowMissingThread: true,
        getSendMode: () => CHAT_SEND_MODE.rawOverride,
      },
      data: buildThreadData(),
      key: threadRef,
      queryClient,
    });

    // A background refetch delivered messages the idle runtime never saw:
    // the acquire must rebuild, seeded from the fresh transcript, wired to
    // THIS caller's getters.
    const rebuilt = acquireChatRuntime({
      activeOrganizationId,
      context: {
        allowMissingThread: true,
        getSendMode: () => CHAT_SEND_MODE.anonymized,
      },
      data: newerThreadData(),
      key: threadRef,
      queryClient,
    });

    expect(rebuilt).not.toBe(first);
    expect(rebuilt.getSnapshot().messages).toMatchObject([
      { id: "message-A", role: "user" },
      { id: assistantMessageId, role: "assistant" },
    ]);

    // The next send resolves its mode through the rebuilt runtime's
    // context. `anonymized` cannot come from the missing-getter fallback
    // (that fallback is `rawOverride`), so this proves the current
    // caller's live getter won.
    await sendThreadChatMessage(
      rebuilt,
      createOutgoingMessage("22222222-2222-4222-8222-2222222222b1"),
    );
    expect(requests.at(0)).toMatchObject({
      sendMode: CHAT_SEND_MODE.anonymized,
      threadId,
    });
  });

  test("keeps a mid-stream runtime even when newer data arrives, then rebuilds after the post-turn refetch", async () => {
    const queryClient = new QueryClient();
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
      return createSseResponse(createFinishedSseChunks());
    });

    // Mirrors the /chat route-handoff: the landing page registers the
    // runtime and starts the stream BEFORE navigating.
    const preSendData = buildThreadData();
    const handoff = acquireChatRuntime({
      activeOrganizationId,
      context: { allowMissingThread: true },
      data: preSendData,
      key: threadRef,
      queryClient,
    });
    const started = handoff.startRouteHandoffMessage(
      createOutgoingMessage("22222222-2222-4222-8222-2222222222b2"),
    );
    await responseRequested;

    // The destination page acquires while the stream is in flight — even
    // with a diverged freshness signal it must reattach, never rebuild
    // (invariant: an in-flight stream survives navigation).
    const reattached = acquireChatRuntime({
      activeOrganizationId,
      context: { allowMissingThread: true },
      data: newerThreadData(),
      key: threadRef,
      queryClient,
    });
    expect(reattached).toBe(handoff);

    releaseResponse();
    await started.stream;

    // Between the turn's onFinish (which only invalidates) and its
    // refetch landing, the component re-renders from the runtime's final
    // stream updates while the CACHED data is still pre-send. That
    // acquire must reattach (stale data equals the entry's frozen
    // build-time seed), keeping the finished turn on screen instead of
    // rebuilding a runtime from pre-send messages.
    const beforeRefetch = acquireChatRuntime({
      activeOrganizationId,
      context: { allowMissingThread: true },
      data: preSendData,
      key: threadRef,
      queryClient,
    });
    expect(beforeRefetch).toBe(handoff);

    // Once the invalidation's refetch lands, the fresh data's signal
    // diverges from the frozen seed and the now-idle runtime is rebuilt
    // from server-authoritative messages with the current caller's
    // getters (this is where a handoff runtime sheds the landing page's
    // getters).
    const afterRefetch = acquireChatRuntime({
      activeOrganizationId,
      context: { allowMissingThread: true },
      data: newerThreadData(),
      key: threadRef,
      queryClient,
    });
    expect(afterRefetch).not.toBe(handoff);
  });

  test("keeps distinct runtimes per context capability set and sweeps them all on query GC", () => {
    const queryClient = new QueryClient();
    installChatRuntimeCleanup(queryClient);
    const data = buildThreadData();

    // Both contexts map to the SAME pure-data query key: contextKind
    // ignores `getActiveDecision`, so both are "plain". Without the
    // capability fingerprint they would collide in the registry and the
    // decision-carrying surface could inherit a runtime whose sends omit
    // activeDecision.
    const plainOptions = chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: { allowMissingThread: true },
    });
    const decisionContext = {
      allowMissingThread: true,
      getActiveDecision: () => ({ decisionId: "decision-A" }),
    };
    expect(
      chatThreadOptions({
        activeOrganizationId,
        key: threadRef,
        context: decisionContext,
      }).queryKey,
    ).toEqual(plainOptions.queryKey);

    const plainRuntime = acquireChatRuntime({
      activeOrganizationId,
      context: { allowMissingThread: true },
      data,
      key: threadRef,
      queryClient,
    });
    const decisionRuntime = acquireChatRuntime({
      activeOrganizationId,
      context: decisionContext,
      data,
      key: threadRef,
      queryClient,
    });
    expect(decisionRuntime).not.toBe(plainRuntime);

    // Each capability set reattaches to its own entry.
    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: { allowMissingThread: true },
        data,
        key: threadRef,
        queryClient,
      }),
    ).toBe(plainRuntime);
    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: decisionContext,
        data,
        key: threadRef,
        queryClient,
      }),
    ).toBe(decisionRuntime);

    // GC of the shared pure-data query sweeps BOTH entries: a fresh
    // acquire on either capability set builds a new runtime.
    queryClient.setQueryData(plainOptions.queryKey, data);
    queryClient.removeQueries({ queryKey: plainOptions.queryKey });
    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: { allowMissingThread: true },
        data,
        key: threadRef,
        queryClient,
      }),
    ).not.toBe(plainRuntime);
    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: decisionContext,
        data,
        key: threadRef,
        queryClient,
      }),
    ).not.toBe(decisionRuntime);
  });

  test("reattaches a busy runtime across capability fingerprints, then rebuilds per fingerprint after the refetch", async () => {
    const queryClient = new QueryClient();
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
      return createSseResponse(createFinishedSseChunks());
    });

    const staleData = buildThreadData();
    const plainContext = { allowMissingThread: true };
    // Inspector-like context: `getActiveDecision` changes the registry
    // fingerprint but not the query key.
    const decisionContext = {
      allowMissingThread: true,
      getActiveDecision: () => ({ decisionId: "decision-A" }),
    };

    // A stale idle entry already exists under the PLAIN fingerprint (a
    // previous main-page visit), then the inspector surface builds its
    // own runtime and starts a stream.
    const idlePlain = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    const streaming = acquireChatRuntime({
      activeOrganizationId,
      context: decisionContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    expect(streaming).not.toBe(idlePlain);
    const started = streaming.startRouteHandoffMessage(
      createOutgoingMessage("22222222-2222-4222-8222-2222222222b3"),
    );
    await responseRequested;

    // "Move to main" mid-stream: the destination page acquires under the
    // plain fingerprint with still-stale data. Busyness must override
    // capability splitting — even though the page has its own idle
    // seed-equal entry, the live stream wins and stays visible.
    const reattached = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    expect(reattached).toBe(streaming);

    releaseResponse();
    await started.stream;

    // After the turn finished and the invalidation's refetch delivered
    // fresh data, the plain surface rebuilds under its OWN fingerprint
    // with its own getters.
    const rebuiltPlain = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: newerThreadData(),
      key: threadRef,
      queryClient,
    });
    expect(rebuiltPlain).not.toBe(streaming);
    expect(rebuiltPlain).not.toBe(idlePlain);

    // No leak: the rebuild explicitly dropped the superseded (idle,
    // diverged-seed) decision-fingerprint entry. Probe with the STALE
    // data — a surviving entry would reattach seed-equal and hand the
    // finished foreign runtime back.
    const decisionAfter = acquireChatRuntime({
      activeOrganizationId,
      context: decisionContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    expect(decisionAfter).not.toBe(streaming);
  });

  test("reattaches a busy runtime across different query keys for the same thread", async () => {
    const queryClient = new QueryClient();
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
      return createSseResponse(createFinishedSseChunks());
    });

    const staleData = buildThreadData();
    const plainContext = { allowMissingThread: true };
    // `getActiveSkill` flips contextKind, so this surface's PURE-DATA
    // query key differs from the plain one — the busy reattach must
    // match on thread identity, not on the query key.
    const skillContext = {
      allowMissingThread: true,
      getActiveSkill: () => ({ skillName: "Summarize" }),
    };
    expect(
      chatThreadOptions({
        activeOrganizationId,
        key: threadRef,
        context: skillContext,
      }).queryKey,
    ).not.toEqual(
      chatThreadOptions({
        activeOrganizationId,
        key: threadRef,
        context: plainContext,
      }).queryKey,
    );

    const streaming = acquireChatRuntime({
      activeOrganizationId,
      context: skillContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    const started = streaming.startRouteHandoffMessage(
      createOutgoingMessage("22222222-2222-4222-8222-2222222222b4"),
    );
    await responseRequested;

    const reattached = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    expect(reattached).toBe(streaming);

    releaseResponse();
    await started.stream;
  });

  test("aliases a foreign busy reattach so the post-finish stale render keeps the finished turn", async () => {
    const queryClient = new QueryClient();
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
      return createSseResponse(createFinishedSseChunks());
    });

    const staleData = buildThreadData();
    const plainContext = { allowMissingThread: true };
    const skillContext = {
      allowMissingThread: true,
      getActiveSkill: () => ({ skillName: "Summarize" }),
    };

    // No prior entry under the plain key: the mid-stream acquire hits
    // the cross-key busy scan and records an alias under it.
    const streaming = acquireChatRuntime({
      activeOrganizationId,
      context: skillContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    const started = streaming.startRouteHandoffMessage(
      createOutgoingMessage("22222222-2222-4222-8222-2222222222b5"),
    );
    await responseRequested;
    const reattached = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    expect(reattached).toBe(streaming);

    releaseResponse();
    await started.stream;

    // Post-finish, pre-refetch: the plain surface re-renders with STALE
    // cached data. Without the alias this would be a registry miss (the
    // runtime is idle now, so the busy scan finds nothing) and a rebuild
    // from pre-send messages — wiping the finished turn. The alias makes
    // it a seed-equal exact hit instead.
    const afterFinishStale = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    expect(afterFinishStale).toBe(streaming);

    // Once the refetch lands, the plain surface rebuilds under its own
    // fingerprint from fresh messages...
    const rebuiltPlain = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: newerThreadData(),
      key: threadRef,
      queryClient,
    });
    expect(rebuiltPlain).not.toBe(streaming);
    // ...replacing the alias (a fresh seed-equal acquire reattaches to
    // the rebuilt runtime, not the finished foreign one)...
    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: plainContext,
        data: newerThreadData(),
        key: threadRef,
        queryClient,
      }),
    ).toBe(rebuiltPlain);
    // ...and dropping the superseded SOURCE entry: probing the skill
    // context with the stale data must build fresh, not resurrect the
    // finished runtime.
    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: skillContext,
        data: staleData,
        key: threadRef,
        queryClient,
      }),
    ).not.toBe(streaming);
  });

  test("GC sweep removes only the entries of the removed query key", () => {
    const queryClient = new QueryClient();
    installChatRuntimeCleanup(queryClient);
    const staleData = buildThreadData();
    const plainContext = { allowMissingThread: true };
    const skillContext = {
      allowMissingThread: true,
      getActiveSkill: () => ({ skillName: "Summarize" }),
    };
    const plainOptions = chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: plainContext,
    });

    const plainRuntime = acquireChatRuntime({
      activeOrganizationId,
      context: plainContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });
    const skillRuntime = acquireChatRuntime({
      activeOrganizationId,
      context: skillContext,
      data: staleData,
      key: threadRef,
      queryClient,
    });

    // Remove only the PLAIN query: its entry is swept, but the sibling
    // query key's entry for the same thread must survive (the sweep is
    // query-key-scoped; only the busy scan and the rebuild cleanup work
    // on thread identity).
    queryClient.setQueryData(plainOptions.queryKey, staleData);
    queryClient.removeQueries({ queryKey: plainOptions.queryKey });

    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: plainContext,
        data: staleData,
        key: threadRef,
        queryClient,
      }),
    ).not.toBe(plainRuntime);
    expect(
      acquireChatRuntime({
        activeOrganizationId,
        context: skillContext,
        data: staleData,
        key: threadRef,
        queryClient,
      }),
    ).toBe(skillRuntime);
  });
});
