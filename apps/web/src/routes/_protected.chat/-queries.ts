import { ChatClient } from "@tanstack/ai-client";
import type {
  ChatClientState,
  MultimodalContent,
  UIMessage,
} from "@tanstack/ai-client";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { DataTag, QueryClient, QueryKey } from "@tanstack/react-query";
import { panic } from "better-result";

import { CHAT_SEND_MODE, isChatSendMode } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { ChatContextUsage } from "@/components/chat/chat-context-meter";
import type {
  ChatClientTools,
  ChatUITools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  hasRunningToolCallInLatestAssistantMessage,
  sanitizeRunningToolCalls,
} from "@/components/chat/chat-ui-tools";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey, toChatThreadId } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
import { useDevStore } from "@/lib/dev-store";
import { APIError, toAPIError } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import type { ChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { invalidateWorkspaceActivity } from "@/routes/_protected.workspaces/-queries";

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

export type ChatThreadOptionsContext = {
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
  modelOptions: (activeOrganizationId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    "modelOptions",
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
  /** Per-thread model override ("provider::modelId"); null uses the org
   *  default (see `chatModelSelection.ts` on the API side). */
  model: string | null;
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
        model: null,
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
    model: response.data.model,
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

type FileChatThreadFetchResult = {
  threadId: ChatThreadId;
  /** The rest mirror `ChatThreadFetched` so the initial message page the
   *  POST resolved (see `resolve-file-thread.ts`) can seed
   *  `chatThreadOptions`' cache directly, collapsing the POST -> GET
   *  /messages waterfall into one round trip. */
  messages: PersistedChatMessage[];
  olderCursor: string | null;
  contextMatterIds: string[];
  lastActivityAt: string | null;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  model: string | null;
  context: ChatContextUsage | null;
};

const fetchFileChatThread = async ({
  entityId,
  fieldId,
  workspaceId,
}: FileChatThreadKey): Promise<FileChatThreadFetchResult> => {
  const response = await api.chat
    .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["file-thread"].post({
      entityId: toSafeId<"entity">(entityId),
      fieldId: toSafeId<"field">(fieldId),
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return {
    threadId: toChatThreadId(response.data.threadId),
    messages: response.data.messages,
    olderCursor: response.data.olderCursor,
    contextMatterIds: response.data.contextMatterIds,
    lastActivityAt: response.data.lastActivityAt,
    webSearchAvailable: response.data.webSearchAvailable,
    webSearchEnabled: response.data.webSearchEnabled,
    model: response.data.model,
    context: response.data.context,
  };
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

  if (!pages) {
    return { global, workspaces: [] };
  }
  for (const page of pages) {
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
      // `client.stop()` aborts the live request but never rewrites message
      // parts, so a tool-call part caught mid-run stays in a running state and
      // keeps `hasRunningToolCallInLatestAssistantMessage` — and thus
      // `isGenerating` — stuck true, wedging the composer on Stop/spinner with
      // the tool card spinning forever. When the aborted turn had a running
      // tool call, finalize it the same way the hydration path does so the
      // turn actually ends.
      if (
        hasRunningToolCallInLatestAssistantMessage({
          messages: snapshot.messages,
        })
      ) {
        const sanitized = sanitizeRunningToolCalls(snapshot.messages);
        client.setMessagesManually(sanitized);
        setSnapshot({ messages: sanitized });
      }
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
  messages: readonly UIMessage<ChatClientTools>[],
): PersistedChatMessage[] => [...messages];

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

class LifecycleRegistry<K, V> {
  private readonly entries = new Map<K, V>();

  get(key: K) {
    return this.entries.get(key);
  }

  set(key: K, value: V) {
    this.entries.set(key, value);
  }

  delete(key: K) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  values() {
    return this.entries.values();
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
  }
}

const activeTurnSendModes = new LifecycleRegistry<
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
 * Test-only escape hatch. The module-level caches are intentionally
 * not cleared automatically; this helper resets them between unit
 * tests so each one starts hermetically.
 */
export const __resetChatRequestStateForTests = (): void => {
  activeTurnSendModes.clear();
  chatRuntimeRegistry.clear();
};

export type ChatThreadFetched = {
  /**
   * Sanitized initial history for this thread (running tool-call
   * parts left by a stream that died mid-call are dropped — see
   * `sanitizeRunningToolCalls`). Pure server data: this
   * query never builds a `ChatRuntime` (see `chatThreadOptions`
   * docs below), so a route loader can prefetch it safely. Callers
   * that need a live runtime pass this array as `initialMessages`
   * to `acquireChatRuntime` / `useChatThreadRuntime`.
   */
  messages: PersistedChatMessage[];
  /**
   * Cursor for the page of messages immediately older than the
   * oldest message in `messages`. Null when the thread's full
   * history is already loaded. Consumers seed local load-older
   * state from this and replace it with each older-page response's
   * cursor.
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
  /** Per-thread model override ("provider::modelId"); null uses the org
   *  default. Mutated via PATCH /chat/threads/:id/model, same shape as
   *  `webSearchEnabled` above. */
  model: string | null;
  /**
   * Model-context estimate for the next send, driving the composer
   * meter. Null for a missing or empty thread (nothing to meter yet).
   */
  context: ChatContextUsage | null;
};

type FileChatThreadOptionsArgs = {
  activeOrganizationId: string;
  key: FileChatThreadKey;
  /**
   * Whether the overlay wires a live Folio editor ref for this file (the
   * DOCX browser-edit surface). This is the same condition
   * `FileChatOverlayInner` uses to decide whether its own
   * `chatThreadContext` carries `handleActiveDocxEditToolCall` or
   * `getActiveFile` — which in turn decides the `contextKind` baked into
   * `chatThreadOptions`' cache key (see `getChatRuntimeContextKind`).
   * Passed through so the seed below lands under the exact key that
   * overlay's `useSuspenseQuery(chatThreadOptions(...))` will look up.
   */
  hasDocxEditSurface: boolean;
};

/** Never actually invoked: exists only so its presence steers
 *  `getChatRuntimeContextKind` to "active-docx-edit", matching the real
 *  `chatThreadContext` the docx-editing overlay builds once mounted. */
const stubHandleActiveDocxEditToolCall = (
  _input: ApplyActiveDocxEditsInput,
): ApplyActiveDocxEditsOutput => ({ applied: [], queued: [], skipped: [] });

/** Never actually invoked: mirrors `getActiveFile`'s presence for the
 *  non-docx (PDF) overlay, steering `getChatRuntimeContextKind` to
 *  "active-file" the same way the real overlay's context does. */
const stubGetActiveFile = (): undefined => undefined;

export const fileChatThreadOptions = ({
  activeOrganizationId,
  key,
  hasDocxEditSurface,
}: FileChatThreadOptionsArgs) =>
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- `hasDocxEditSurface` deliberately excluded from this query's key: the file-thread identity it resolves is the same regardless of docx-vs-pdf, it only steers which sibling `chatThreadOptions` cache key the queryFn seeds below.
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.fileThread(activeOrganizationId, key),
    queryFn: async ({ client }) => {
      const fetched = await fetchFileChatThread(key);

      // Seed chatThreadOptions' pure-data cache with the message page this
      // POST already loaded server-side (see resolve-file-thread.ts), so the
      // overlay's own useSuspenseQuery(chatThreadOptions(...)) right after
      // this resolves from cache instead of firing a second GET /messages —
      // collapsing the POST -> GET waterfall into one round trip.
      const threadRef: ChatThreadRef = {
        scope: "workspace",
        threadId: fetched.threadId,
        workspaceId: key.workspaceId,
      };
      const stubContext: ChatThreadOptionsContext = hasDocxEditSurface
        ? {
            allowMissingThread: true,
            handleActiveDocxEditToolCall: stubHandleActiveDocxEditToolCall,
          }
        : { allowMissingThread: true, getActiveFile: stubGetActiveFile };

      client.setQueryData(
        chatThreadOptions({
          activeOrganizationId,
          key: threadRef,
          context: stubContext,
        }).queryKey,
        {
          messages: sanitizeRunningToolCalls(fetched.messages),
          olderCursor: fetched.olderCursor,
          contextMatterIds: fetched.contextMatterIds,
          lastActivityAt: fetched.lastActivityAt,
          webSearchAvailable: fetched.webSearchAvailable,
          webSearchEnabled: fetched.webSearchEnabled,
          model: fetched.model,
          context: fetched.context,
        },
      );

      return fetched.threadId;
    },
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

/**
 * Cache-identity key shared by `chatThreadOptions`' `queryKey` and the
 * runtime registry below. Keeping both derivations behind this one
 * helper guarantees a query cache entry and its registered `ChatRuntime`
 * are always addressed by the exact same (org, thread, allowMissingThread,
 * contextKind) tuple — they can drift in content, never in identity.
 */
const chatThreadCacheKey = ({
  activeOrganizationId,
  context,
  key,
}: {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
}) =>
  chatKeys.thread(activeOrganizationId, {
    ...key,
    allowMissingThread: context?.allowMissingThread,
    contextKind: getChatRuntimeContextKind(context),
  });

/**
 * Durable identity of the THREAD a registry entry streams into: org +
 * scope (+ workspaceId for workspace scope) + threadId, and nothing
 * else. Deliberately excludes `allowMissingThread`, `contextKind`, and
 * the transport version — those vary per SURFACE (they are query-cache
 * concerns), while a live stream belongs to the thread itself: the
 * cross-fingerprint busy reattach and the rebuild-time cleanup of
 * superseded entries must see every entry for the thread regardless of
 * which surface's query key it was registered under. JSON-encoded so
 * user-controlled ids cannot collide with a separator.
 */
const chatThreadIdentity = ({
  activeOrganizationId,
  key,
}: {
  activeOrganizationId: string;
  key: ChatThreadKey;
}): string =>
  key.scope === "global"
    ? JSON.stringify([activeOrganizationId, key.scope, key.threadId])
    : JSON.stringify([
        activeOrganizationId,
        key.scope,
        key.workspaceId,
        key.threadId,
      ]);

// Every context capability (getter/handler) that changes what a runtime
// SENDS. `allowMissingThread` is excluded: it shapes the fetch, not the
// send, and is already part of the query key.
const CHAT_CONTEXT_CAPABILITY_KEYS = [
  "getActiveDecision",
  "getActiveExternal",
  "getActiveFile",
  "getActiveSkill",
  "getActiveTemplate",
  "getContextMatterIds",
  "getSendMode",
  "getUserContext",
  "handleActiveDocxEditToolCall",
] as const satisfies readonly (keyof ChatThreadOptionsContext)[];

/**
 * Deterministic encoding of WHICH capabilities a context carries (fixed
 * declaration order, presence only). Registry identity is deliberately
 * STRICTER than cache identity: the pure-data query is context-free, so
 * distinct surfaces may share one cache entry (and the query key must
 * stay stable for invalidation targeting), but a runtime's send path
 * uses exactly the getters present at build time. `contextKind` in the
 * query key only records the FIRST matched kind and ignores getters like
 * `getActiveDecision` entirely, so two surfaces with different
 * capability sets can share a query key; without this fingerprint an
 * idle runtime built by the capability-poorer surface could be reused
 * seed-equal by the richer one, and its sends would silently omit that
 * context.
 */
const chatContextCapabilityFingerprint = (
  context: ChatThreadOptionsContext | undefined,
): string =>
  CHAT_CONTEXT_CAPABILITY_KEYS.filter(
    (capability) => context?.[capability] !== undefined,
  ).join(",");

export const chatThreadOptions = ({
  activeOrganizationId,
  key,
  context,
}: ChatThreadOptionsArgs) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    // This query fetches PURE thread data — messages, cursor, matter ids,
    // web-search flags, context estimate — and nothing else. It never
    // builds a `ChatRuntime`, on purpose: a route loader can call
    // `ensureRouteQueryData(chatThreadOptions(...))` before any chat
    // component has mounted, with no live `getUserContext` /
    // `getContextMatterIds` / `getSendMode` getters available yet. If
    // queryFn built the runtime here, a loader-triggered fetch would bake
    // in a stub context for the runtime's entire lifetime (until the next
    // invalidation) — including the first `sendMode` resolution, which
    // would silently fall back to `CHAT_SEND_MODE.rawOverride` and drop
    // the user's anonymization choice. See `acquireChatRuntime` /
    // `useChatThreadRuntime`: the runtime is always built at the point a
    // component (or the `/chat` route-handoff sender) actually holds live
    // getters, never here.
    //
    // `structuralSharing: false` is kept even though this query's data no
    // longer embeds a `ChatRuntime` (the historical reason it was added —
    // see the "chat runtime identity across query refetch" tests). Every
    // refetch of this query still means "the server's authoritative
    // messages changed"; handing back a fresh object each time (instead of
    // walking it for structural equality) keeps that signal simple and
    // costs nothing since nothing here is expensive to diff.
    structuralSharing: false,
    queryKey: chatThreadCacheKey({ activeOrganizationId, context, key }),
    queryFn: async (): Promise<ChatThreadFetched> => {
      const fetched = await fetchThreadMessages(key, {
        allowMissingThread: context.allowMissingThread,
      });

      return {
        ...fetched,
        // Thread hydration is the one place persisted messages enter a
        // fresh runtime with no live turn; drop any tool-call part left
        // running by a stream that died mid call so the session does not
        // load already wedged as "generating". See
        // `sanitizeRunningToolCalls`.
        messages: sanitizeRunningToolCalls(fetched.messages),
      };
    },
  });

/**
 * Server-authoritative freshness signal a runtime was seeded with,
 * remembered alongside its registry entry so a later acquire can tell
 * whether the incoming pure-data fetch carries anything the runtime was
 * not BUILT from. Both fields together are the signal: `lastActivityAt`
 * alone cannot distinguish two states of a thread edited within the same
 * timestamp resolution, and the last message id alone cannot see a
 * truncate-and-replay that lands back on the same tail message.
 *
 * INVARIANT: captured once at build time and never updated afterwards —
 * deliberately, even though the runtime's own transcript advances as
 * turns stream. That staleness is what drives replacement: after a turn
 * finishes, `onFinish` only invalidates the pure-data query (it does NOT
 * evict — see the registry docs for the race that eviction caused);
 * until the refetch lands, acquire compares the stale cached data
 * against this equally stale build-time seed → equal → reattach, and the
 * runtime keeps showing the finished turn it holds internally. Once the
 * refetch lands, the fresh data's signal diverges from this frozen seed
 * → idle rebuild from server-authoritative messages. Updating the seed
 * on stream progress would break exactly that divergence detection.
 */
type ChatRuntimeSeedSignal = {
  lastActivityAt: string | null;
  lastMessageId: string | null;
};

type ChatRuntimeRegistryEntry = {
  runtime: ChatRuntime;
  seed: ChatRuntimeSeedSignal;
  /**
   * Stringified query key of the pure-data query this entry belongs to.
   * The registry key is this string PLUS the context-capability
   * fingerprint, so one query key can own several entries; the GC sweep
   * in `installChatRuntimeCleanup` uses this field to find all of them
   * (and ONLY them — a removed query must not sweep entries registered
   * under a sibling query key for the same thread).
   */
  queryKeyString: string;
  /**
   * Durable thread identity (see `chatThreadIdentity`), shared by every
   * entry for the thread across query keys and fingerprints. The busy
   * cross-fingerprint reattach and the rebuild-time cleanup of
   * superseded entries match on this, never on `queryKeyString`.
   */
  threadIdentity: string;
};

const toChatRuntimeSeedSignal = (
  data: ChatThreadFetched,
): ChatRuntimeSeedSignal => ({
  lastActivityAt: data.lastActivityAt,
  lastMessageId: data.messages.at(-1)?.id ?? null,
});

const seedSignalsEqual = (
  left: ChatRuntimeSeedSignal,
  right: ChatRuntimeSeedSignal,
): boolean =>
  left.lastActivityAt === right.lastActivityAt &&
  left.lastMessageId === right.lastMessageId;

/**
 * Whether a runtime has live work in flight that a rebuild would kill:
 * an active stream (`status` submitted/streaming, `isLoading` covers a
 * locally-pending optimistic send whose response has not started yet),
 * a server-side generation session (`sessionGenerating`), or a running
 * tool call awaiting its result/approval in the latest assistant turn
 * (which `status` alone does not cover — between tool hops the client
 * is technically "ready"). A busy runtime is never replaced; once its
 * turn finishes and the `onFinish` invalidation's refetch lands, the
 * idle reconcile in `acquireChatRuntime` rebuilds it.
 */
const isChatRuntimeBusy = (runtime: ChatRuntime): boolean => {
  const snapshot = runtime.getSnapshot();
  return (
    snapshot.isLoading ||
    snapshot.sessionGenerating ||
    snapshot.status === "submitted" ||
    snapshot.status === "streaming" ||
    hasRunningToolCallInLatestAssistantMessage({
      messages: snapshot.messages,
    })
  );
};

/**
 * Live `ChatRuntime` instances, keyed by cache identity (see
 * `chatThreadCacheKey`) PLUS context-capability fingerprint (see
 * `chatContextCapabilityFingerprint`). A runtime is built lazily, from
 * whichever caller's live context getters are on hand the first time its
 * key is resolved, and then reused:
 *   - across a component unmount/remount (thread revisit within the pure
 *     data query's `gcTime`) so an in-flight stream stays attached — see
 *     `useChatThreadRuntime`;
 *   - across the `/chat` landing page's route-handoff send, which calls
 *     `acquireChatRuntime` directly (no mounted component yet) to start
 *     the stream before navigating; the destination route's first render
 *     resolves the same key (identical capability set) and reattaches
 *     instead of building a second, competing runtime;
 *   - across SURFACES while a stream is live: a busy runtime is
 *     reattached even from a different capability fingerprint or query
 *     key (moving a chat between the inspector and the main page
 *     mid-stream) — see `findBusyChatRuntimeEntryForThread` and the
 *     alias mechanism in `acquireChatRuntime`.
 *
 * A hit is NOT unconditional: when the runtime is idle and the incoming
 * pure-data fetch carries a signal that diverges from the entry's frozen
 * build-time seed, the entry is rebuilt from the current caller's live
 * getters and fresh messages — see `acquireChatRuntime`. That one rule
 * covers both refresh paths:
 *   - a background refetch (window-refocus staleness, cross-tab/device
 *     invalidation) picked up messages the runtime never saw;
 *   - this runtime's own finished turn: `onFinish` only INVALIDATES the
 *     pure-data query — it must not evict, because the component
 *     re-renders from the runtime's final stream updates BEFORE the
 *     refetch lands, and an evicted entry would make that render's
 *     acquire (still holding pre-send cached data) rebuild from stale
 *     messages, wiping the just-finished turn off the screen until (or
 *     unless) the refetch wins. With the entry left in place, that
 *     interim acquire sees stale-data-equals-stale-seed → reattach, and
 *     the post-refetch acquire sees the divergence → rebuild from
 *     server-authoritative messages with the mounted caller's getters.
 *
 * Entries are swept when TanStack garbage-collects the matching
 * pure-data query (see `installChatRuntimeCleanup`) so a thread opened
 * once and never revisited doesn't hold its runtime — and every message
 * it ever streamed — in memory indefinitely.
 */
const chatRuntimeRegistry = new LifecycleRegistry<
  string,
  ChatRuntimeRegistryEntry
>();

/**
 * Registry key: query-key string + capability fingerprint. IDLE entries
 * never cross capability sets even when they share a pure-data cache
 * entry; BUSY entries do — see `findBusyChatRuntimeEntryForThread`.
 */
const toChatRuntimeRegistryKey = (
  queryKeyString: string,
  context: ChatThreadOptionsContext | undefined,
): string => `${queryKeyString}#${chatContextCapabilityFingerprint(context)}`;

/**
 * BUSYNESS OVERRIDES CAPABILITY SPLITTING. The fingerprint keeps idle
 * runtimes from crossing capability sets because what matters there is
 * the NEXT send: it must be configured by the acquiring surface's own
 * getters. A busy runtime is different — its in-flight turn was already
 * configured by the surface that started it, so reattaching another
 * surface to it for display cannot mis-scope anything, while NOT
 * reattaching would hide a live stream: moving a chat between surfaces
 * mid-stream (inspector "move to main"/"move to side") lands on a
 * surface whose fingerprint differs (the inspector always passes
 * `getActiveDecision`; the page does not), and an exact-fingerprint
 * lookup alone would miss the streaming runtime and rebuild from stale
 * data. Once the turn finishes, `onFinish` invalidates, the refetch
 * diverges the seed, and the idle reconcile rebuilds under the
 * acquiring surface's own fingerprint with its own getters — capability
 * purity is restored at exactly the moment it matters again.
 *
 * Matched on THREAD identity, not query key: the query key embeds
 * `contextKind` (and `allowMissingThread`), so an inspector surface
 * opened with `getActiveSkill` registers under an "active-skill" query
 * key while the main page acquires the same thread under the "plain"
 * one — a query-key-scoped scan would miss that live stream entirely.
 *
 * Sends are serialized per thread in the UI, so two busy entries for
 * one thread should not occur; if state ever degrades to that, the
 * first entry in Map insertion order wins, deterministically.
 */
const findBusyChatRuntimeEntryForThread = (
  threadIdentity: string,
): ChatRuntimeRegistryEntry | undefined => {
  for (const entry of chatRuntimeRegistry.values()) {
    if (
      entry.threadIdentity === threadIdentity &&
      isChatRuntimeBusy(entry.runtime)
    ) {
      return entry;
    }
  }
  return undefined;
};

const isChatThreadQueryKey = (queryKey: unknown): boolean =>
  Array.isArray(queryKey) &&
  queryKey.at(0) === "chat" &&
  queryKey.at(2) === "thread";

const chatRuntimeCleanupInstalledClients = new WeakSet<QueryClient>();

/**
 * Wire `chatRuntimeRegistry` eviction to the query cache's own GC.
 * Idempotent per `QueryClient` (mirrors `installPDFDocumentCleanup`);
 * call once, e.g. wherever the app's `QueryClient` is constructed.
 */
export const installChatRuntimeCleanup = (queryClient: QueryClient): void => {
  if (chatRuntimeCleanupInstalledClients.has(queryClient)) {
    return;
  }
  chatRuntimeCleanupInstalledClients.add(queryClient);

  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "removed" ||
      !isChatThreadQueryKey(event.query.queryKey)
    ) {
      return;
    }
    // One query key can own several registry entries (one per context
    // capability fingerprint), so sweep by the entry's recorded query
    // key rather than deleting a single map key. Deleting during Map
    // iteration is safe per spec.
    const removedKeyString = JSON.stringify(event.query.queryKey);
    for (const [registryKey, entry] of chatRuntimeRegistry) {
      if (entry.queryKeyString === removedKeyString) {
        chatRuntimeRegistry.delete(registryKey);
      }
    }
  });
};

export type AcquireChatRuntimeArgs = {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext | undefined;
  /**
   * The pure-data result of the matching `chatThreadOptions` query.
   * Seeds a freshly built runtime (`messages` are already sanitized by
   * the queryFn) and provides the freshness signal for the idle
   * reconcile on a registry hit.
   */
  data: ChatThreadFetched;
  key: ChatThreadKey;
  queryClient: QueryClient;
};

/**
 * Resolve the live `ChatRuntime` for a thread, building and registering
 * one from `context`'s live getters on a registry miss. See
 * `chatRuntimeRegistry`'s docs for the full reuse/replacement lifecycle.
 *
 * Reattach priority, reconciled against `data`'s freshness signal:
 *   1. Busy runtime under the caller's exact registry key: returned
 *      unconditionally, regardless of signal. Never replace mid-stream —
 *      this is what keeps an in-flight chat alive across navigation, and
 *      what makes the `/chat` route-handoff work: the handoff sender
 *      registers the runtime and starts the stream BEFORE navigating, so
 *      the destination page's acquire (identical fingerprint) lands here
 *      and reattaches instead of rebuilding.
 *   2. Busy runtime under ANY other registry key for the same THREAD
 *      (any fingerprint, any query key — the inspector's active-skill
 *      surface and the main page's plain surface use different query
 *      keys for one thread): returned unconditionally — see
 *      `findBusyChatRuntimeEntryForThread` (busyness overrides
 *      capability splitting). Checked BEFORE the idle exact reattach so
 *      a stale idle entry left under the acquiring surface's own key can
 *      never shadow a live stream running under a foreign one. The
 *      reattach also records an ALIAS entry under the ACQUIRER's
 *      registry key — same runtime object, the source entry's seed — so
 *      that after the stream finishes but before the refetch lands, the
 *      acquirer's stale-data render takes the idle seed-equal exact hit
 *      (priority 3) instead of missing and rebuilding from pre-send
 *      messages (the finding-1 race, reintroduced through this path
 *      without the alias). Idempotent across renders: once the alias
 *      exists, subsequent busy renders resolve it at priority 1.
 *   3. Idle exact-key runtime, signal equal to the entry's build-time
 *      seed: returned as-is. This covers a plain revisit AND the window
 *      between a turn's `onFinish` (which only invalidates) and its
 *      refetch landing: cached data is still pre-send, the frozen seed
 *      is too, so the runtime — which holds the finished turn
 *      internally — is kept and the transcript never flickers back.
 *   4. Rebuild: the refetch (or a cross-tab/device background refetch)
 *      delivered messages the exact-key runtime was not built from, or
 *      no entry exists. Build from the CURRENT caller's live getters and
 *      fresh sanitized messages (the pre-registry design rebuilt on
 *      every queryFn run; this is the idle-only equivalent). This is
 *      also the moment a busy-reattached foreign runtime — or a
 *      route-handoff runtime — sheds its originating surface's getters
 *      in favour of the mounted caller's. Superseded same-thread entries
 *      (idle, diverged seed — finished streams whose data has been
 *      refetched, including both a busy-reattach's SOURCE entry and any
 *      ALIAS of it under other keys) are explicitly deleted here so one
 *      thread does not accumulate a dead entry per fingerprint;
 *      seed-equal entries are kept — they belong to a concurrently
 *      mounted surface built from the same fresh data.
 */
export const acquireChatRuntime = ({
  activeOrganizationId,
  context,
  data,
  key,
  queryClient,
}: AcquireChatRuntimeArgs): ChatRuntime => {
  const queryKeyString = JSON.stringify(
    chatThreadCacheKey({ activeOrganizationId, context, key }),
  );
  const registryKey = toChatRuntimeRegistryKey(queryKeyString, context);
  const threadIdentity = chatThreadIdentity({ activeOrganizationId, key });
  const seed = toChatRuntimeSeedSignal(data);
  const existing = chatRuntimeRegistry.get(registryKey);
  // Priority 1: busy runtime under the exact registry key.
  if (existing !== undefined && isChatRuntimeBusy(existing.runtime)) {
    return existing.runtime;
  }
  // Priority 2: busy runtime under any other registry key for this
  // thread. Record an alias under the acquirer's key (same runtime, the
  // source's seed) so the post-finish stale render reattaches via the
  // seed-equal exact hit instead of rebuilding from pre-send messages.
  // Overwrites a stale idle exact entry on purpose: the user is looking
  // at the streaming runtime now, so a later seed-equal hit must return
  // it, not the pre-stream leftover.
  const busyEntry = findBusyChatRuntimeEntryForThread(threadIdentity);
  if (busyEntry !== undefined) {
    chatRuntimeRegistry.set(registryKey, {
      runtime: busyEntry.runtime,
      seed: busyEntry.seed,
      queryKeyString,
      threadIdentity,
    });
    return busyEntry.runtime;
  }
  // Priority 3: idle exact-key reattach on an unchanged signal.
  if (existing !== undefined && seedSignalsEqual(existing.seed, seed)) {
    return existing.runtime;
  }
  // Priority 4: rebuild. Every entry for this thread is idle here (the
  // busy scan above found none), so drop superseded same-thread entries —
  // idle, diverged seed — before registering the replacement; the `set`
  // at the end replaces the exact-key entry atomically.
  for (const [staleKey, entry] of chatRuntimeRegistry) {
    if (
      staleKey !== registryKey &&
      entry.threadIdentity === threadIdentity &&
      !seedSignalsEqual(entry.seed, seed)
    ) {
      chatRuntimeRegistry.delete(staleKey);
    }
  }

  const runtime = createChatRuntime({
    context,
    initialMessages: data.messages,
    key,
    onError: (error) => {
      getAnalytics().captureError(error);
    },
    onFinish: () => {
      // Invalidate only — do NOT evict the registry entry here. The
      // component re-renders from the runtime's final stream updates
      // before this invalidation's refetch lands; with the entry gone
      // that render's acquire would be a registry MISS against still
      // stale cached data and would rebuild from pre-send messages,
      // wiping the finished turn until the refetch wins (or forever if
      // it fails). Kept in place, the entry reattaches seed-equal until
      // the refetch lands, then the idle reconcile replaces it.
      void Promise.all([
        invalidateChatThread({ queryClient, threadRef: key }),
        invalidateChatThreadLists({
          queryClient,
          workspaceId: key.scope === "workspace" ? key.workspaceId : undefined,
        }),
      ]);
    },
  });
  chatRuntimeRegistry.set(registryKey, {
    runtime,
    seed,
    queryKeyString,
    threadIdentity,
  });
  return runtime;
};

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

const fetchChatModelOptions = async () => {
  const response = await api.chat["model-options"].get();

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};

// The composer (+) menu's Models submenu fetches this lazily (only once the
// menu opens) rather than eagerly on composer mount, so opening the chat
// surface never fires the request for users who never touch the picker.
export const modelOptionsOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: chatKeys.modelOptions(activeOrganizationId),
    staleTime: STALE_TIME.FIVE.MINUTES,
    queryFn: async () => await fetchChatModelOptions(),
  });

export const groupedChatThreadsOptions = (activeOrganizationId: string) => {
  const initialPageParam: string | undefined = undefined;
  return infiniteQueryOptions({
    queryKey: chatKeys.groupedThreads(activeOrganizationId),
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    refetchOnWindowFocus: false,
    queryFn: async ({ pageParam, signal }): Promise<GroupedChatThreadsPage> =>
      await fetchGroupedChatThreads({ cursor: pageParam, signal }),
    initialPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
};

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

export const invalidateChatThreadLists = async ({
  queryClient,
  workspaceId,
}: {
  queryClient: QueryClient;
  workspaceId: string | undefined;
}) =>
  await Promise.all([
    invalidateGroupedChatThreads(queryClient),
    ...(workspaceId
      ? [invalidateWorkspaceActivity(queryClient, workspaceId)]
      : []),
  ]);

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

/**
 * Apply a persisted model-selection change to one query's cache entry, then
 * invalidate the thread across scopes so any other cached view (inspector
 * tab, other scope) picks it up too. `queryKey` must come from a
 * `queryOptions()` call (its data type is inferred from the key's tag), so
 * this only accepts a cache entry shaped like `{ model }` -- exactly what
 * `chatThreadOptions` and the draft `/chat` composer's own meta query
 * return. Shared by every composer surface with a Models submenu so the
 * cache-update + invalidation pairing can't drift between them again.
 */
export const applyChatModelChange = ({
  model,
  queryClient,
  queryKey,
  threadId,
}: {
  model: string | null;
  queryClient: QueryClient;
  queryKey: DataTag<QueryKey, { model: string | null }, Error>;
  threadId: ChatThreadId;
}): void => {
  queryClient.setQueryData(queryKey, (prev) =>
    prev ? { ...prev, model } : prev,
  );
  void invalidateChatThreadAcrossScopes({ queryClient, threadId });
};
