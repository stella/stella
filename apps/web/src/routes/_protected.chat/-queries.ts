import { ChatClient } from "@tanstack/ai-client";
import type {
  ChatClientState,
  ChatClientOptions,
  MultimodalContent,
  UIMessage,
} from "@tanstack/ai-client";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { CHAT_SEND_MODE, isChatSendMode } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { ChatContextUsage } from "@/components/chat/chat-context-meter";
import type {
  ChatClientTools,
  ChatMessageMetadata,
  ChatUITools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { sanitizeHydratedRunningToolCalls } from "@/components/chat/chat-ui-tools";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey, toChatThreadId } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
import { useDevStore } from "@/lib/dev-store";
import { APIError, toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import type { ChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";

type ActiveFileContext = {
  docxEditSnapshot?:
    | {
        blocks: {
          displayLabel?: string | undefined;
          id: string;
          kind: "heading" | "listItem" | "paragraph";
          styleId?: string | undefined;
          text: string;
        }[];
        canApplyEdits?: boolean | undefined;
      }
    | undefined;
  entityId: string;
  fileFieldId?: string | undefined;
  fileName: string;
  supportsDocxEdits?: boolean | undefined;
};

type ActiveTemplateContext = {
  docxEditSnapshot?: ActiveFileContext["docxEditSnapshot"];
  fileName: string;
  templateId: string;
};

type ActiveDecisionContext = {
  decisionId: string;
};

type ActiveExternalContext = {
  connectorSlug?: string | undefined;
  provider?: string | undefined;
  snippet?: string | undefined;
  sourceToolName?: string | undefined;
  text?: string | undefined;
  title: string;
  url: string;
};

export type ActiveSkillContext = {
  skillId?: string | undefined;
  skillName: string;
};

type ChatThreadKey = ChatThreadRef;

type FileChatThreadKey = {
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

type TemplateChatThreadKey = {
  templateId: string;
};

type ChatThreadTitleKey = {
  threadId: string;
  workspaceId?: string | undefined;
};

type GroupedChatThreadsPage = Awaited<
  ReturnType<typeof fetchGroupedChatThreads>
>;
export type GroupedChatThreads = Pick<
  GroupedChatThreadsPage,
  "global" | "workspaces"
>;

const APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME = "apply-active-docx-edits";
export const SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE =
  "suggest-template-fields" as const;
const CHAT_THREADS_PAGE_SIZE = 50;
const CHAT_TRANSPORT_VERSION = 2;

type ChatToolScope = typeof SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE;

export type ApplyActiveDocxEditsInput =
  ChatUITools[typeof APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]["input"];

export type ApplyActiveDocxEditsOutput =
  ChatUITools[typeof APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]["output"];

type ChatThreadOptionsContext = {
  allowMissingThread?: boolean | undefined;
  getActiveDecision?: (() => ActiveDecisionContext | undefined) | undefined;
  getActiveExternal?: (() => ActiveExternalContext | undefined) | undefined;
  getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
  getActiveSkill?: (() => ActiveSkillContext | undefined) | undefined;
  getActiveTemplate?: (() => ActiveTemplateContext | undefined) | undefined;
  /**
   * Matters this chat draws context from. The transport sends the
   * current value (an empty array means "no matters pinned"). The
   * server persists it on the thread and re-uses it on subsequent
   * turns; the picker UI calls back here on every change so the
   * next send carries the latest set.
   */
  getContextMatterIds?: (() => string[]) | undefined;
  getSendMode?: (() => ChatSendMode) | undefined;
  getUserContext?: (() => ChatUserContext) | undefined;
  handleActiveDocxEditToolCall?:
    | ((
        input: ApplyActiveDocxEditsInput,
      ) => ApplyActiveDocxEditsOutput | Promise<ApplyActiveDocxEditsOutput>)
    | undefined;
};

type ChatRuntimeContextKind =
  | "active-docx-edit"
  | "active-external"
  | "active-file"
  | "active-skill"
  | "active-template"
  | "plain";

type ChatThreadQueryKey = ChatThreadRef & {
  allowMissingThread?: boolean | undefined;
  contextKind?: ChatRuntimeContextKind | undefined;
};

const getChatRuntimeContextKind = (
  context: ChatThreadOptionsContext | undefined,
): ChatRuntimeContextKind => {
  if (context?.handleActiveDocxEditToolCall) {
    return "active-docx-edit";
  }

  if (context?.getActiveFile) {
    return "active-file";
  }

  if (context?.getActiveExternal) {
    return "active-external";
  }

  if (context?.getActiveSkill) {
    return "active-skill";
  }

  if (context?.getActiveTemplate) {
    return "active-template";
  }

  return "plain";
};

export const chatKeys = {
  all: ["chat"],
  fileThread: (activeOrganizationId: string, key: FileChatThreadKey) => [
    ...chatKeys.all,
    activeOrganizationId,
    "file-thread",
    key.workspaceId,
    key.entityId,
    key.fieldId,
  ],
  templateThread: (
    activeOrganizationId: string,
    key: TemplateChatThreadKey,
  ) => [
    ...chatKeys.all,
    activeOrganizationId,
    "template-thread",
    key.templateId,
  ],
  groupedThreads: (activeOrganizationId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    "threads",
    "grouped",
  ],
  threadTitle: (activeOrganizationId: string, key: ChatThreadTitleKey) => [
    ...chatKeys.all,
    activeOrganizationId,
    "thread-title",
    key.workspaceId ?? "global",
    key.threadId,
  ],
  thread: (activeOrganizationId: string, key: ChatThreadQueryKey) =>
    key.scope === "global"
      ? [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          key.scope,
          key.threadId,
          key.allowMissingThread ?? false,
          key.contextKind ?? "plain",
          CHAT_TRANSPORT_VERSION,
        ]
      : [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          key.scope,
          key.workspaceId,
          key.threadId,
          key.allowMissingThread ?? false,
          key.contextKind ?? "plain",
          CHAT_TRANSPORT_VERSION,
        ],
  // Sits under the per-thread prefix (chat, org, thread, scope, …ids)
  // so `invalidateChatThread` drops it too; keyed by the latest
  // message id so a new turn yields a fresh entry.
  recap: (
    activeOrganizationId: string,
    threadRef: ChatThreadRef,
    lastMessageId: string,
  ) =>
    threadRef.scope === "global"
      ? [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          threadRef.scope,
          threadRef.threadId,
          "recap",
          lastMessageId,
        ]
      : [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          threadRef.scope,
          threadRef.workspaceId,
          threadRef.threadId,
          "recap",
          lastMessageId,
        ],
  suggestedPrompts: (
    activeOrganizationId: string,
    threadRef: ChatThreadRef,
    lastMessageId: string,
  ) =>
    threadRef.scope === "global"
      ? [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          threadRef.scope,
          threadRef.threadId,
          "suggestedPrompts",
          lastMessageId,
        ]
      : [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          threadRef.scope,
          threadRef.workspaceId,
          threadRef.threadId,
          "suggestedPrompts",
          lastMessageId,
        ],
};

type ChatThreadOptionsInput = QueryOptionsInput<
  ChatThreadKey,
  ChatThreadOptionsContext
>;

type ThreadFetch = {
  messages: PersistedChatMessage[];
  /** Cursor for the page before the oldest loaded message; null when none. */
  olderCursor: string | null;
  contextMatterIds: string[];
  /** ISO timestamp of the most recent message, or null when empty. */
  lastActivityAt: string | null;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  /** Model-context estimate for the next send; null for a missing or empty
   *  thread (nothing to meter yet). */
  context: ChatContextUsage | null;
};

export type ChatUserMessageInput = MultimodalContent & {
  id: SafeId<"chatMessage">;
};
export type ChatRouteHandoffMessage = ChatUserMessageInput;
export type ChatContinuationRequestBody = {
  sendMode?: ChatSendMode | undefined;
  toolScope?: ChatToolScope | undefined;
  truncateAfterMessageId?: SafeId<"chatMessage"> | undefined;
};
export type ChatSendMessageOptions = {
  body?: ChatContinuationRequestBody | undefined;
};
export type ChatRouteHandoffStart = {
  messageId: SafeId<"chatMessage">;
  status: "started";
  stream: Promise<void>;
};

type ChatRuntimeSnapshot = {
  error: Error | undefined;
  isLoading: boolean;
  messages: PersistedChatMessage[];
  sessionGenerating: boolean;
  status: ChatClientState;
};

type TanStackClientToolResult = Parameters<
  ChatClient<ChatClientTools>["addToolResult"]
>[0];

export type ChatToolResultInput = Omit<TanStackClientToolResult, "output"> & {
  output: unknown;
};

const CHAT_RUNTIME_BRAND: unique symbol = Symbol("StellaChatRuntime");

export type ChatRuntime = {
  readonly [CHAT_RUNTIME_BRAND]: true;
  addToolApprovalResponse: (
    response: {
      approved: boolean;
      id: string;
    },
    options?: ChatSendMessageOptions,
  ) => Promise<void>;
  addToolResult: (
    result: ChatToolResultInput,
    options?: ChatSendMessageOptions,
  ) => Promise<void>;
  getSnapshot: () => ChatRuntimeSnapshot;
  reload: (options?: ChatSendMessageOptions) => Promise<void>;
  setMessages: (messages: PersistedChatMessage[]) => void;
  startRouteHandoffMessage: (
    message: ChatRouteHandoffMessage,
    options?: ChatSendMessageOptions,
  ) => ChatRouteHandoffStart;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
};

type ChatThreadSendMessage = (
  message: ChatUserMessageInput,
  options?: ChatSendMessageOptions,
) => Promise<void>;

const threadSendMessageByRuntime = new WeakMap<
  ChatRuntime,
  ChatThreadSendMessage
>();

export const sendThreadChatMessage = async (
  chat: ChatRuntime,
  message: ChatUserMessageInput,
  options?: ChatSendMessageOptions,
): Promise<void> => {
  const sendMessage = threadSendMessageByRuntime.get(chat);
  if (sendMessage === undefined) {
    panic("Missing thread send capability for chat runtime");
  }

  await sendMessage(message, options);
};

const fetchThreadMessages = async (
  key: ChatThreadKey,
  {
    allowMissingThread = false,
  }: {
    allowMissingThread?: boolean | undefined;
  } = {},
): Promise<ThreadFetch> => {
  const response = await api.chat
    .threads({ threadId: key.threadId })
    .messages.get({
      query: {
        ...(allowMissingThread ? { allowMissingThread: true } : {}),
        ...(key.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(key.workspaceId) }
          : {}),
      },
    });

  if (response.error) {
    const error = toAPIError(response.error);

    if (allowMissingThread && APIError.is(error) && error.status === 404) {
      return {
        messages: [],
        olderCursor: null,
        contextMatterIds: [],
        lastActivityAt: null,
        webSearchAvailable: false,
        webSearchEnabled: false,
        context: null,
      };
    }

    throw error;
  }

  return {
    messages: response.data.messages,
    olderCursor: response.data.olderCursor,
    contextMatterIds: response.data.contextMatterIds,
    lastActivityAt: response.data.lastActivityAt,
    webSearchAvailable: response.data.webSearchAvailable,
    webSearchEnabled: response.data.webSearchEnabled,
    context: response.data.context,
  };
};

type OlderMessagesFetch = {
  messages: PersistedChatMessage[];
  olderCursor: string | null;
};

export const fetchOlderMessages = async ({
  key,
  before,
}: {
  key: ChatThreadKey;
  before: string;
}): Promise<OlderMessagesFetch> => {
  const response = await api.chat
    .threads({ threadId: key.threadId })
    .messages.older.get({
      query: {
        before,
        ...(key.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(key.workspaceId) }
          : {}),
      },
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return {
    messages: response.data.messages,
    olderCursor: response.data.olderCursor,
  };
};

const fetchGroupedChatThreads = async ({
  cursor,
  signal,
}: {
  cursor?: string | undefined;
  signal?: AbortSignal | undefined;
} = {}) => {
  const response = await api.chat.threads.get({
    ...(signal !== undefined && { fetch: { signal } }),
    query: {
      limit: CHAT_THREADS_PAGE_SIZE,
      ...(cursor !== undefined && { cursor }),
    },
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};

const fetchFileChatThread = async ({
  entityId,
  fieldId,
  workspaceId,
}: FileChatThreadKey): Promise<ChatThreadId> => {
  const response = await api.chat
    .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["file-thread"].post({
      entityId: toSafeId<"entity">(entityId),
      fieldId: toSafeId<"field">(fieldId),
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return toChatThreadId(response.data.threadId);
};

const fetchTemplateChatThread = async ({
  templateId,
}: TemplateChatThreadKey): Promise<ChatThreadId> => {
  const response = await api.chat["template-thread"].post({
    templateId: toSafeId<"template">(templateId),
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return toChatThreadId(response.data.threadId);
};

export const mergeGroupedChatThreadPages = (
  pages: readonly GroupedChatThreadsPage[] | undefined,
): GroupedChatThreads => {
  const global: GroupedChatThreads["global"] = [];
  const workspacesById = new Map<
    string,
    GroupedChatThreads["workspaces"][number]
  >();
  const seenThreadIds = new Set<string>();

  for (const page of pages ?? []) {
    for (const thread of page.global) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      global.push(thread);
    }

    for (const workspace of page.workspaces) {
      const existing = workspacesById.get(workspace.workspaceId);
      if (!existing) {
        const threads: typeof workspace.threads = [];
        for (const thread of workspace.threads) {
          if (seenThreadIds.has(thread.id)) {
            continue;
          }
          seenThreadIds.add(thread.id);
          threads.push(thread);
        }
        workspacesById.set(workspace.workspaceId, { ...workspace, threads });
        continue;
      }

      for (const thread of workspace.threads) {
        if (seenThreadIds.has(thread.id)) {
          continue;
        }
        seenThreadIds.add(thread.id);
        existing.threads.push(thread);
      }
    }
  }

  return { global, workspaces: Array.from(workspacesById.values()) };
};

const getChatApiPath = () => apiUrl("/chat");

type ChatDevtoolsBridgeFactory = NonNullable<
  ChatClientOptions<ChatClientTools>["devtoolsBridgeFactory"]
>;
type ChatDevtoolsBridge = ReturnType<ChatDevtoolsBridgeFactory>;

type ChatRunEventContext = {
  runId: string;
  threadId: string;
  toolCallId?: string | undefined;
};

type ChatEventContext = Partial<ChatRunEventContext>;

type StellaNoopChatClientEvents = {
  approvalRequested: (...args: unknown[]) => void;
  clientCreated: (...args: unknown[]) => void;
  errorChanged: (...args: unknown[]) => void;
  loadingChanged: (...args: unknown[]) => void;
  messageAppended: (...args: unknown[]) => void;
  messageSent: (...args: unknown[]) => void;
  messagesCleared: (...args: unknown[]) => void;
  reloaded: (...args: unknown[]) => void;
  stopped: (...args: unknown[]) => void;
  structuredOutputChanged: (...args: unknown[]) => void;
  textUpdated: (...args: unknown[]) => void;
  thinkingUpdated: (...args: unknown[]) => void;
  toolApprovalResponded: (...args: unknown[]) => void;
  toolCallStateChanged: (...args: unknown[]) => void;
  toolFixtureApplied: (...args: unknown[]) => void;
  toolResultAdded: (...args: unknown[]) => void;
};

type StellaNoopChatDevtoolsBridge = {
  applyFixture: (...args: unknown[]) => Promise<void>;
  beginRun: (runId: string, threadId: string) => void;
  deactivate: () => void;
  dispose: () => void;
  emitRegistered: () => void;
  emitRunLifecycle: (...args: unknown[]) => void;
  emitSnapshot: () => void;
  emitToolsRegistered: () => void;
  emitUpdated: () => void;
  events: StellaNoopChatClientEvents;
  findToolCallContext: (toolCallId: string) => ChatEventContext;
  getCurrentOrLastRunEventContext: () => ChatRunEventContext | undefined;
  getCurrentRunEventContext: () => ChatRunEventContext | undefined;
  getCurrentStreamId: () => string | null;
  getLastStreamId: () => string | null;
  mountWithTools: (initialMessageCount: number) => void;
  notifyToolsChanged: () => void;
  observeChunk: (chunk: {
    runId?: string | undefined;
    threadId?: string | undefined;
    type: string;
  }) => void;
  resolveStreamId: () => string;
  setCurrentStreamId: (streamId: string | null) => void;
  supersede: () => void;
};

const ignoreNoopDevtoolsEvent = (...args: readonly unknown[]): void => {
  void args;
};

const resolveNoopDevtoolsEvent = async (
  ...args: readonly unknown[]
): Promise<void> => {
  void args;
  await Promise.resolve();
};

const createNoopChatClientEvents = (): StellaNoopChatClientEvents => ({
  approvalRequested: ignoreNoopDevtoolsEvent,
  clientCreated: ignoreNoopDevtoolsEvent,
  errorChanged: ignoreNoopDevtoolsEvent,
  loadingChanged: ignoreNoopDevtoolsEvent,
  messageAppended: ignoreNoopDevtoolsEvent,
  messageSent: ignoreNoopDevtoolsEvent,
  messagesCleared: ignoreNoopDevtoolsEvent,
  reloaded: ignoreNoopDevtoolsEvent,
  stopped: ignoreNoopDevtoolsEvent,
  structuredOutputChanged: ignoreNoopDevtoolsEvent,
  textUpdated: ignoreNoopDevtoolsEvent,
  thinkingUpdated: ignoreNoopDevtoolsEvent,
  toolApprovalResponded: ignoreNoopDevtoolsEvent,
  toolCallStateChanged: ignoreNoopDevtoolsEvent,
  toolFixtureApplied: ignoreNoopDevtoolsEvent,
  toolResultAdded: ignoreNoopDevtoolsEvent,
});

const createStellaNoopChatDevtoolsBridge: ChatDevtoolsBridgeFactory = (
  options,
) => {
  let currentStreamId: string | null = null;
  let lastStreamId: string | null = null;
  let currentRunContext: ChatRunEventContext | undefined;
  let lastRunContext: ChatRunEventContext | undefined;

  const bridge = {
    events: createNoopChatClientEvents(),
    applyFixture: resolveNoopDevtoolsEvent,
    beginRun: (runId: string, threadId: string) => {
      currentRunContext = { runId, threadId };
      lastRunContext = currentRunContext;
    },
    deactivate: ignoreNoopDevtoolsEvent,
    dispose: ignoreNoopDevtoolsEvent,
    emitRegistered: ignoreNoopDevtoolsEvent,
    emitRunLifecycle: ignoreNoopDevtoolsEvent,
    emitSnapshot: ignoreNoopDevtoolsEvent,
    emitToolsRegistered: ignoreNoopDevtoolsEvent,
    emitUpdated: ignoreNoopDevtoolsEvent,
    findToolCallContext: (toolCallId: string) => ({
      ...lastRunContext,
      toolCallId,
    }),
    getCurrentOrLastRunEventContext: () => currentRunContext ?? lastRunContext,
    getCurrentRunEventContext: () => currentRunContext,
    getCurrentStreamId: () => currentStreamId,
    getLastStreamId: () => lastStreamId,
    mountWithTools: ignoreNoopDevtoolsEvent,
    notifyToolsChanged: ignoreNoopDevtoolsEvent,
    observeChunk: (chunk: {
      runId?: string | undefined;
      threadId?: string | undefined;
      type: string;
    }) => {
      if (chunk.type === "RUN_STARTED" && chunk.runId && chunk.threadId) {
        currentRunContext = {
          runId: chunk.runId,
          threadId: chunk.threadId,
        };
        lastRunContext = currentRunContext;
        return;
      }

      if (
        (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") &&
        (!chunk.runId || chunk.runId === currentRunContext?.runId)
      ) {
        currentRunContext = undefined;
      }
    },
    resolveStreamId: () =>
      currentStreamId ?? lastStreamId ?? options.generateId("stream"),
    setCurrentStreamId: (streamId: string | null) => {
      currentStreamId = streamId;
      if (streamId) {
        lastStreamId = streamId;
      }
    },
    supersede: ignoreNoopDevtoolsEvent,
  } satisfies StellaNoopChatDevtoolsBridge;

  // SAFETY: TanStack's ChatDevtoolsBridge return type is a concrete class with
  // private implementation details, so a consumer-side no-op cannot satisfy it
  // structurally. This object implements the public bridge surface that
  // ChatClient calls, including beta methods missing from TanStack's bundled
  // no-op bridge (`mountWithTools`, `notifyToolsChanged`).
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return bridge as unknown as ChatDevtoolsBridge;
};

type CreateChatRuntimeProps = {
  context: ChatThreadOptionsContext | undefined;
  initialMessages: PersistedChatMessage[];
  key: ChatThreadKey;
  onError: (error: Error) => void;
  onFinish: () => void;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const ignoreAbandonedStreamError = (error: unknown): void => {
  void error;
};

class ChatMessageStartError extends Error {
  readonly messageId: SafeId<"chatMessage">;

  constructor(messageId: SafeId<"chatMessage">) {
    super(
      `TanStack ChatClient did not append user message "${messageId}" before starting the stream.`,
    );
    this.name = "ChatMessageStartError";
    this.messageId = messageId;
  }
}

export const isChatMessageStartError = (
  error: unknown,
): error is ChatMessageStartError => error instanceof ChatMessageStartError;

const hasUserMessage = (
  messages: readonly PersistedChatMessage[],
  messageId: SafeId<"chatMessage">,
): boolean =>
  messages.some(
    (message) => message.role === "user" && message.id === messageId,
  );

export const createChatRuntime = ({
  context,
  initialMessages,
  key,
  onError,
  onFinish,
}: CreateChatRuntimeProps): ChatRuntime => {
  const listeners = new Set<() => void>();
  let snapshot: ChatRuntimeSnapshot = {
    error: undefined,
    isLoading: false,
    messages: initialMessages,
    sessionGenerating: false,
    status: "ready",
  };

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setSnapshot = (patch: Partial<ChatRuntimeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    emit();
  };

  const captureRuntimeError = (error: unknown): Error => {
    const normalized = toError(error);
    if (snapshot.error !== normalized) {
      onError(normalized);
      setSnapshot({ error: normalized });
    }
    return normalized;
  };

  const reportRuntimeError = (error: unknown): void => {
    void captureRuntimeError(error);
  };

  const client = new ChatClient<ChatClientTools>({
    id: getChatThreadKey(key),
    threadId: key.threadId,
    initialMessages,
    devtoolsBridgeFactory: createStellaNoopChatDevtoolsBridge,
    fetcher: async (input, { signal }) => {
      const response = await fetch(getChatApiPath(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildSendRequestBody({
            context,
            key,
            messages: toPersistedChatMessages(input.messages),
            requestBody: normalizeChatContinuationRequestBody(input.data),
          }),
        ),
        signal,
      });

      return response;
    },
    onError: (error) => {
      onError(error);
      setSnapshot({ error });
    },
    onErrorChange: (error) => setSnapshot({ error }),
    onFinish: () => {
      onFinish();
    },
    onLoadingChange: (isLoading) => setSnapshot({ isLoading }),
    onMessagesChange: (messages) =>
      setSnapshot({ messages: toPersistedChatMessages(messages) }),
    onSessionGeneratingChange: (sessionGenerating) =>
      setSnapshot({ sessionGenerating }),
    onStatusChange: (status) => setSnapshot({ status }),
  });

  const withBody = async (
    options: ChatSendMessageOptions | undefined,
    action: () => Promise<void>,
  ) => {
    if (options?.body !== undefined) {
      client.updateOptions({ body: options.body });
    }

    try {
      await action();
    } finally {
      if (options?.body !== undefined) {
        client.updateOptions({ body: {} });
      }
    }
  };

  const sendThreadMessage: ChatThreadSendMessage = async (message, options) => {
    const stream = client.sendMessage(message, options?.body);

    if (!hasUserMessage(snapshot.messages, message.id)) {
      void stream.catch(ignoreAbandonedStreamError);
      const error = new ChatMessageStartError(message.id);
      captureRuntimeError(error);
      throw error;
    }

    try {
      await stream;
    } catch (error) {
      throw captureRuntimeError(error);
    }
  };

  const runtime = {
    [CHAT_RUNTIME_BRAND]: true,
    addToolApprovalResponse: async (response, options) => {
      await withBody(options, async () => {
        await client.addToolApprovalResponse(response);
      });
    },
    addToolResult: async (result, options) => {
      await withBody(options, async () => {
        await client.addToolResult({
          tool: result.tool,
          toolCallId: result.toolCallId,
          output: result.output,
          ...(result.state === undefined ? {} : { state: result.state }),
          ...(result.errorText === undefined
            ? {}
            : { errorText: result.errorText }),
        });
      });
    },
    getSnapshot: () => snapshot,
    reload: async (options) => {
      await withBody(options, async () => {
        await client.reload();
      });
    },
    setMessages: (messages) => {
      client.setMessagesManually(messages);
      setSnapshot({ messages });
    },
    startRouteHandoffMessage: (message, options) => {
      const stream = client.sendMessage(message, options?.body);

      if (!hasUserMessage(snapshot.messages, message.id)) {
        void stream.catch(ignoreAbandonedStreamError);
        throw captureRuntimeError(new ChatMessageStartError(message.id));
      }

      void stream.catch(reportRuntimeError);
      return { messageId: message.id, status: "started", stream };
    },
    stop: () => {
      client.stop();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies ChatRuntime;

  threadSendMessageByRuntime.set(runtime, sendThreadMessage);

  return runtime;
};

const toPersistedChatMessages = (
  messages: readonly UIMessage[],
): PersistedChatMessage[] =>
  messages.map((message) => {
    const metadata = readChatMessageMetadata(message);
    return {
      id: message.id,
      role: message.role,
      // SAFETY: ChatClient is constructed with Stella ChatClientTools and every
      // message entering this runtime is either server-normalized ChatMessage
      // history or a message created by that typed TanStack client. TanStack's
      // fetcher callback currently exposes non-generic UIMessage[], so this
      // is the single runtime boundary where we reattach the stricter tool
      // tuple type.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      parts: message.parts as PersistedChatMessage["parts"],
      ...(metadata === undefined ? {} : { metadata }),
    };
  });

const readChatMessageMetadata = (
  message: UIMessage,
): ChatMessageMetadata | undefined => {
  if (!("metadata" in message) || typeof message.metadata !== "object") {
    return undefined;
  }

  // SAFETY: metadata only exists on Stella ChatMessage objects. TanStack keeps
  // unknown extra fields intact at runtime but does not type them on UIMessage.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return message.metadata as ChatMessageMetadata;
};

export const buildSendRequestBody = ({
  context,
  key,
  messages,
  requestBody,
}: {
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
  messages: PersistedChatMessage[];
  requestBody?: ChatContinuationRequestBody | undefined;
}) => {
  const message = messages.at(-1);
  if (!message) {
    panic("Missing chat message");
  }

  const body: {
    activeDecision?: ActiveDecisionContext | undefined;
    activeExternal?: ActiveExternalContext | undefined;
    activeFile?: ActiveFileContext | undefined;
    activeSkill?: ActiveSkillContext | undefined;
    activeTemplate?: ActiveTemplateContext | undefined;
    contextMatterIds?: string[] | undefined;
    devModelId?: string | undefined;
    message: PersistedChatMessage;
    sendMode: ChatSendMode;
    threadId: ChatThreadId;
    toolScope?: ChatToolScope | undefined;
    truncateAfterMessageId?: SafeId<"chatMessage"> | undefined;
    userContext?: ChatUserContext | undefined;
    workspaceId?: string | undefined;
  } = {
    message,
    sendMode: resolveChatRequestSendMode({
      context,
      key,
      messages,
      requestBody,
    }),
    threadId: key.threadId,
  };

  if (requestBody?.truncateAfterMessageId !== undefined) {
    body.truncateAfterMessageId = requestBody.truncateAfterMessageId;
  }

  if (requestBody?.toolScope !== undefined) {
    body.toolScope = requestBody.toolScope;
  }

  if (key.scope === "workspace") {
    body.workspaceId = key.workspaceId;
  }

  const userContext = context?.getUserContext?.();
  if (userContext) {
    body.userContext = userContext;
  }

  const activeFile = context?.getActiveFile?.();
  if (activeFile) {
    body.activeFile = activeFile;
  }

  const activeDecision = context?.getActiveDecision?.();
  if (activeDecision) {
    body.activeDecision = activeDecision;
  }

  const activeExternal = context?.getActiveExternal?.();
  if (activeExternal) {
    body.activeExternal = activeExternal;
  }

  const activeSkill = context?.getActiveSkill?.();
  if (activeSkill) {
    body.activeSkill = activeSkill;
  }

  const activeTemplate = context?.getActiveTemplate?.();
  if (activeTemplate) {
    body.activeTemplate = activeTemplate;
  }

  const contextMatterIds = context?.getContextMatterIds?.();
  if (contextMatterIds !== undefined) {
    body.contextMatterIds = contextMatterIds;
  }

  if (import.meta.env.DEV) {
    const devModelId = useDevStore.getState().chatModelId;
    if (devModelId) {
      body.devModelId = devModelId;
    }
  }

  return body;
};

const getRequestSendMode = (
  requestBody: ChatContinuationRequestBody | undefined,
): ChatSendMode | null => requestBody?.sendMode ?? null;

type ResolveChatRequestSendModeProps = {
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
  messages: readonly PersistedChatMessage[];
  requestBody: ChatContinuationRequestBody | undefined;
};

const resolveChatRequestSendMode = ({
  context,
  key,
  messages,
  requestBody,
}: ResolveChatRequestSendModeProps): ChatSendMode => {
  const explicitSendMode = getRequestSendMode(requestBody);
  const threadKey = getChatThreadKey(key);
  const userMessageId = getLatestUserMessageId(messages);
  const activeTurn = activeTurnSendModes.get(threadKey);
  const sendMode =
    explicitSendMode ??
    (activeTurn?.userMessageId === userMessageId
      ? activeTurn.sendMode
      : null) ??
    context?.getSendMode?.() ??
    CHAT_SEND_MODE.rawOverride;

  if (userMessageId) {
    activeTurnSendModes.set(threadKey, { sendMode, userMessageId });
  }

  return sendMode;
};

const getLatestUserMessageId = (
  messages: readonly PersistedChatMessage[],
): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (message?.role === "user") {
      return message.id;
    }
  }

  return null;
};

const activeTurnSendModes = new Map<
  string,
  { sendMode: ChatSendMode; userMessageId: string }
>();

const normalizeChatContinuationRequestBody = (
  data: unknown,
): ChatContinuationRequestBody | undefined => {
  if (!isRecord(data)) {
    return undefined;
  }

  const body: ChatContinuationRequestBody = {};
  if (isChatSendMode(data["sendMode"])) {
    body.sendMode = data["sendMode"];
  }
  if (data["toolScope"] === SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE) {
    body.toolScope = data["toolScope"];
  }
  if (typeof data["truncateAfterMessageId"] === "string") {
    body.truncateAfterMessageId = toSafeId<"chatMessage">(
      data["truncateAfterMessageId"],
    );
  }

  return Object.keys(body).length === 0 ? undefined : body;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Test-only escape hatch. The module-level cache is intentionally
 * not cleared automatically; this helper resets it between unit
 * tests so each one starts hermetically.
 */
export const __resetChatRequestStateForTests = (): void => {
  activeTurnSendModes.clear();
};

export type ChatThreadFetched = {
  chat: ChatRuntime;
  /**
   * Cursor for the page of messages immediately older than the
   * oldest message in `chat`. Null when the thread's full history
   * is already loaded. Consumers seed local load-older state from
   * this and replace it with each older-page response's cursor.
   */
  olderCursor: string | null;
  /**
   * Persisted contextMatterIds for this thread, fresh from the
   * server. Consumers feed this into local picker state on mount;
   * subsequent changes flow back through `getContextMatterIds` on
   * the transport, not through this read.
   */
  contextMatterIds: string[];
  /**
   * ISO timestamp of the most recent persisted message (null for an
   * empty thread). Drives the revisit-recap staleness check.
   */
  lastActivityAt: string | null;
  webSearchAvailable: boolean;
  /**
   * Per-thread web-search opt-in. Mutated via PATCH /chat/threads/:id
   * with optimistic cache update; the next send-message reads the
   * persisted value to decide whether to expose the web_search +
   * fetch_url tools to the model.
   */
  webSearchEnabled: boolean;
  /**
   * Model-context estimate for the next send, driving the composer
   * meter. Null for a missing or empty thread (nothing to meter yet).
   */
  context: ChatContextUsage | null;
};

type FileChatThreadOptionsArgs = {
  activeOrganizationId: string;
  key: FileChatThreadKey;
};

export const fileChatThreadOptions = ({
  activeOrganizationId,
  key,
}: FileChatThreadOptionsArgs) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.fileThread(activeOrganizationId, key),
    queryFn: async () => await fetchFileChatThread(key),
  });

type TemplateChatThreadOptionsArgs = {
  activeOrganizationId: string;
  key: TemplateChatThreadKey;
};

export const templateChatThreadOptions = ({
  activeOrganizationId,
  key,
}: TemplateChatThreadOptionsArgs) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.templateThread(activeOrganizationId, key),
    queryFn: async () => await fetchTemplateChatThread(key),
  });

export type ChatThreadOptionsArgs = ChatThreadOptionsInput & {
  activeOrganizationId: string;
};

export const chatThreadOptions = ({
  activeOrganizationId,
  key,
  context,
}: ChatThreadOptionsArgs) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    // The query data carries a live `ChatRuntime`: a plain object with a
    // `Symbol` brand key and function-valued methods, registered by object
    // identity in `threadSendMessageByRuntime`. TanStack's default
    // structural sharing (`replaceEqualDeep`) walks the data on every
    // refetch and, because the runtime's method closures differ across
    // queryFn runs, rebuilds `data.chat` into a fresh `{}` copy. That copy
    // is a distinct identity the WeakMap never saw, and `Object.keys`
    // iteration drops the `Symbol` brand, so `sendThreadChatMessage` would
    // panic with "Missing thread send capability". Each queryFn run already
    // creates and registers a new runtime (see `onFinish` invalidation and
    // the `seededChat` re-seed in useChatSession), so there is nothing for
    // structural sharing to preserve here: hand the registered runtime back
    // verbatim. INVARIANT: any query whose data embeds a `ChatRuntime` must
    // opt out of structural sharing.
    structuralSharing: false,
    queryKey: chatKeys.thread(activeOrganizationId, {
      ...key,
      allowMissingThread: context.allowMissingThread,
      contextKind: getChatRuntimeContextKind(context),
    }),
    queryFn: async ({ client: queryClient }): Promise<ChatThreadFetched> => {
      const {
        messages,
        olderCursor,
        contextMatterIds,
        lastActivityAt,
        webSearchAvailable,
        webSearchEnabled,
        context: contextUsage,
      } = await fetchThreadMessages(key, {
        allowMissingThread: context.allowMissingThread,
      });

      const chat = createChatRuntime({
        context,
        // Thread hydration is the one place persisted messages enter a
        // fresh runtime with no live turn; drop any tool-call part left
        // running by a stream that died mid call so the session does not
        // load already wedged as "generating". See
        // `sanitizeHydratedRunningToolCalls`.
        initialMessages: sanitizeHydratedRunningToolCalls(messages),
        key,
        onError: (error) => {
          getAnalytics().captureError(error);
        },
        onFinish: () => {
          void Promise.all([
            invalidateChatThread({ queryClient, threadRef: key }),
            invalidateGroupedChatThreads(queryClient),
          ]);
        },
      });

      return {
        chat,
        olderCursor,
        contextMatterIds,
        lastActivityAt,
        webSearchAvailable,
        webSearchEnabled,
        context: contextUsage,
      };
    },
  });

type ChatThreadRecapFetched = {
  recap: string | null;
};

const fetchThreadRecap = async (
  threadRef: ChatThreadRef,
): Promise<ChatThreadRecapFetched> => {
  const response = await api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
    .recap.post(undefined, {
      query:
        threadRef.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
          : {},
    });

  if (response.error) {
    // A recap is a non-critical nicety: surface nothing on failure,
    // but keep the error in telemetry.
    getAnalytics().captureError(toAPIError(response.error));
    return { recap: null };
  }

  return { recap: response.data.recap };
};

type ChatThreadRecapOptionsArgs = {
  activeOrganizationId: string;
  enabled: boolean;
  lastMessageId: string;
  threadRef: ChatThreadRef;
};

export const chatThreadRecapOptions = ({
  activeOrganizationId,
  enabled,
  lastMessageId,
  threadRef,
}: ChatThreadRecapOptionsArgs) =>
  queryOptions({
    enabled,
    // A given message tail yields a stable recap (cached server-side),
    // so never auto-refetch; a new message produces a new cache key.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.recap(activeOrganizationId, threadRef, lastMessageId),
    queryFn: async () => await fetchThreadRecap(threadRef),
  });

type ChatThreadSuggestedPromptsFetched = {
  prompts: string[];
};

const fetchThreadSuggestedPrompts = async (
  threadRef: ChatThreadRef,
): Promise<ChatThreadSuggestedPromptsFetched> => {
  const response = await api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
    ["suggested-prompts"].post(undefined, {
      query:
        threadRef.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
          : {},
    });

  if (response.error) {
    getAnalytics().captureError(toAPIError(response.error));
    return { prompts: [] };
  }

  return { prompts: response.data.prompts };
};

type ChatThreadSuggestedPromptsOptionsArgs = {
  activeOrganizationId: string;
  enabled: boolean;
  lastMessageId: string;
  threadRef: ChatThreadRef;
};

export const chatThreadSuggestedPromptsOptions = ({
  activeOrganizationId,
  enabled,
  lastMessageId,
  threadRef,
}: ChatThreadSuggestedPromptsOptionsArgs) =>
  queryOptions({
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.suggestedPrompts(
      activeOrganizationId,
      threadRef,
      lastMessageId,
    ),
    queryFn: async () => await fetchThreadSuggestedPrompts(threadRef),
  });

export const groupedChatThreadsOptions = (activeOrganizationId: string) =>
  infiniteQueryOptions({
    queryKey: chatKeys.groupedThreads(activeOrganizationId),
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    refetchOnWindowFocus: false,
    queryFn: async ({ pageParam, signal }): Promise<GroupedChatThreadsPage> =>
      await fetchGroupedChatThreads({ cursor: pageParam, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

const fetchChatThreadTitle = async ({
  threadId,
  workspaceId,
}: ChatThreadTitleKey): Promise<string> => {
  const response = await api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadId) })
    .title.get({
      query: workspaceId
        ? { workspaceId: toSafeId<"workspace">(workspaceId) }
        : {},
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data.title;
};

type ChatThreadTitleOptionsArgs = {
  activeOrganizationId: string;
  enabled: boolean;
  key: ChatThreadTitleKey;
};

// By-id title read for shared chrome (the chat breadcrumb). The grouped-threads
// list only holds the first loaded pages, so opening an older thread that has
// scrolled out of that window would otherwise leave the crumb without a title.
// The breadcrumb reads the grouped cache first and only enables this query on a
// miss, so a thread already in the list never triggers a redundant fetch.
export const chatThreadTitleOptions = ({
  activeOrganizationId,
  enabled,
  key,
}: ChatThreadTitleOptionsArgs) =>
  queryOptions({
    enabled,
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.threadTitle(activeOrganizationId, key),
    queryFn: async () => await fetchChatThreadTitle(key),
  });

export const invalidateGroupedChatThreads = async (queryClient: QueryClient) =>
  await queryClient.invalidateQueries({
    refetchType: "inactive",
    // Match every cached `["chat", <orgId>, "threads", "grouped"]` entry —
    // we cannot reconstruct orgId here so we walk by structural shape.
    predicate: (query) => {
      const queryKey = query.queryKey;
      return (
        queryKey.at(0) === "chat" &&
        queryKey.at(2) === "threads" &&
        queryKey.at(3) === "grouped"
      );
    },
  });

export const invalidateChatThread = async ({
  queryClient,
  threadRef,
}: {
  queryClient: QueryClient;
  threadRef: ChatThreadRef;
}) =>
  await queryClient.invalidateQueries({
    predicate: (query) => {
      const queryKey = query.queryKey;
      if (
        queryKey.at(0) !== "chat" ||
        queryKey.at(2) !== "thread" ||
        queryKey.at(3) !== threadRef.scope
      ) {
        return false;
      }

      if (threadRef.scope === "global") {
        return queryKey.at(4) === threadRef.threadId;
      }

      return (
        queryKey.at(4) === threadRef.workspaceId &&
        queryKey.at(5) === threadRef.threadId
      );
    },
  });

/**
 * Whether a query key targets the given chat thread under any
 * scope. Exported for tests; the runtime uses it via
 * `invalidateChatThreadAcrossScopes` below.
 */
export const matchesChatThreadAcrossScopes = (
  queryKey: readonly unknown[],
  threadId: ChatThreadId,
): boolean => {
  if (queryKey.at(0) !== "chat" || queryKey.at(2) !== "thread") {
    return false;
  }
  // queryKey.at(1) is the orgId; we accept any value here since
  // the predicate is used to invalidate the same thread across
  // surfaces (and orgs) when scope changes.
  const scope = queryKey.at(3);
  if (scope === "global") {
    return queryKey.at(4) === threadId;
  }
  if (scope === "workspace") {
    return queryKey.at(5) === threadId;
  }
  return false;
};

/**
 * Invalidate every cached query for a chat thread regardless of
 * scope. Used when a thread moves between the standalone /chat
 * surface and the inspector tab — the destination surface uses a
 * different cache key (the scope is part of the key), so the old
 * scope's entry would otherwise serve stale data on the next
 * visit. Scoped by `threadId` only because that's the durable
 * identity; scope+workspace are surface-bound.
 */
export const invalidateChatThreadAcrossScopes = async ({
  queryClient,
  threadId,
}: {
  queryClient: QueryClient;
  threadId: ChatThreadId;
}) =>
  await queryClient.invalidateQueries({
    predicate: (query) =>
      matchesChatThreadAcrossScopes(query.queryKey, threadId),
  });
