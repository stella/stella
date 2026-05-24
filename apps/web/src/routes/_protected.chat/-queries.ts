import { Chat } from "@ai-sdk/react";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { panic } from "better-result";
import { v7 as uuidv7 } from "uuid";

import { CHAT_SEND_MODE, isChatSendMode } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type {
  ChatUITools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  hasApprovalResponseAwaitingModelStep,
  hasApprovedActiveDocxEditAwaitingClientOutput,
} from "@/components/chat/chat-ui-tools";
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
import type { ChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";

type ActiveFileContext = {
  docxEditSnapshot?:
    | {
        blocks: {
          displayLabel?: string | undefined;
          id: string;
          kind: "heading" | "listItem" | "paragraph";
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

type ChatThreadKey = ChatThreadRef;

type FileChatThreadKey = {
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

type GroupedChatThreadsPage = Awaited<
  ReturnType<typeof fetchGroupedChatThreads>
>;
export type GroupedChatThreads = Pick<
  GroupedChatThreadsPage,
  "global" | "workspaces"
>;

const APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME = "apply-active-docx-edits";
const CHAT_THREADS_PAGE_SIZE = 50;
const CHAT_TRANSPORT_VERSION = 2;

export type ApplyActiveDocxEditsInput =
  ChatUITools[typeof APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]["input"];

export type ApplyActiveDocxEditsOutput =
  ChatUITools[typeof APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]["output"];

type ChatThreadOptionsContext = {
  allowMissingThread?: boolean | undefined;
  getActiveDecision?: (() => ActiveDecisionContext | undefined) | undefined;
  getActiveExternal?: (() => ActiveExternalContext | undefined) | undefined;
  getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
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
  groupedThreads: (activeOrganizationId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    "threads",
    "grouped",
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
};

type ChatThreadOptionsInput = QueryOptionsInput<
  ChatThreadKey,
  ChatThreadOptionsContext
>;

type ThreadFetch = {
  messages: PersistedChatMessage[];
  contextMatterIds: string[];
  webSearchEnabled: boolean;
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
      return { messages: [], contextMatterIds: [], webSearchEnabled: false };
    }

    throw error;
  }

  return {
    messages: response.data.messages,
    contextMatterIds: response.data.contextMatterIds,
    webSearchEnabled: response.data.webSearchEnabled,
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

export const buildSendRequestBody = ({
  context,
  key,
  messages,
  requestBody,
}: {
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
  messages: PersistedChatMessage[];
  requestBody?: object | undefined;
}) => {
  const message = messages.at(-1);
  if (!message) {
    panic("Missing chat message");
  }

  const body: {
    activeDecision?: ActiveDecisionContext | undefined;
    activeExternal?: ActiveExternalContext | undefined;
    activeFile?: ActiveFileContext | undefined;
    contextMatterIds?: string[] | undefined;
    devModelId?: string | undefined;
    message: PersistedChatMessage;
    sendMode: ChatSendMode;
    threadId: string;
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
  requestBody: object | undefined,
): ChatSendMode | null => {
  if (!requestBody || !("sendMode" in requestBody)) {
    return null;
  }

  return isChatSendMode(requestBody.sendMode) ? requestBody.sendMode : null;
};

type ResolveChatRequestSendModeProps = {
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
  messages: readonly PersistedChatMessage[];
  requestBody: object | undefined;
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

// Per-thread guard against empty-completion auto-resubmit storms.
// When a model returns finish_reason=stop with zero tokens (observed
// with cached prefixes on small Gemini variants), the AI SDK does
// not append a new assistant message, so the same tool-result tail
// keeps satisfying the predicate and useChat resubmits at ~1.5 Hz
// until the user reloads. Tracking the latest assistant message's
// tool-state fingerprint breaks that loop while still allowing the
// same assistant message to advance through multiple sequential
// tool calls.
//
// State lives at module scope (keyed by the thread's first message
// id) instead of inside the predicate's closure: the chat-thread
// query gets invalidated after every successful turn and the
// queryFn recreates the `Chat` + a fresh predicate. A purely
// closure-scoped fingerprint resets every time, which let the loop
// re-arm itself. Module scope survives invalidation; the cap is a
// hard ceiling per fingerprint regardless of how many Chat
// instances exist for the same thread.
//
// Cap of 1 mirrors the original "fire once per fingerprint"
// semantic; legitimate sequential tool calls advance the
// fingerprint (each new tool result adds a part), so each gets its
// own one-fire budget. Anything higher would just reopen the loop
// the closure version used to suffer from.
const MAX_AUTO_FIRES_PER_FINGERPRINT = 1;
type ThreadAutoFireState = {
  fingerprint: string | null;
  fires: number;
};
const threadAutoFireState = new Map<string, ThreadAutoFireState>();
const activeTurnSendModes = new Map<
  string,
  { sendMode: ChatSendMode; userMessageId: string }
>();

/**
 * Test-only escape hatch. The module-level cache is intentionally
 * not cleared automatically; this helper resets it between unit
 * tests so each one starts hermetically.
 */
export const __resetChatRequestStateForTests = (): void => {
  activeTurnSendModes.clear();
  threadAutoFireState.clear();
};

const getThreadAutoFireKey = (
  messages: readonly PersistedChatMessage[],
): string | null => messages[0]?.id ?? null;

export const createSendAutomaticallyPredicate =
  () =>
  ({ messages }: { messages: PersistedChatMessage[] }) => {
    if (hasApprovedActiveDocxEditAwaitingClientOutput({ messages })) {
      return false;
    }
    const lastMessage = messages.at(-1);
    const fingerprint = getAutoSendFingerprint(lastMessage);
    if (!fingerprint) {
      return false;
    }
    const threadKey = getThreadAutoFireKey(messages);
    if (!threadKey) {
      return false;
    }
    const state = threadAutoFireState.get(threadKey) ?? {
      fingerprint: null,
      fires: 0,
    };
    // Different fingerprint → fresh tail, reset the counter.
    if (state.fingerprint !== fingerprint) {
      state.fingerprint = fingerprint;
      state.fires = 0;
    }
    // Hard cap: any future regression that reopens the loop hits
    // this ceiling and stops automatically. 3 covers the
    // legitimate sequential-tool-call case (each tool result lands
    // with a new fingerprint, so each new fingerprint gets its own
    // budget).
    if (state.fires >= MAX_AUTO_FIRES_PER_FINGERPRINT) {
      threadAutoFireState.set(threadKey, state);
      return false;
    }
    const shouldFire =
      hasApprovalResponseAwaitingModelStep({ messages }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages });
    if (shouldFire) {
      state.fires += 1;
    }
    threadAutoFireState.set(threadKey, state);
    return shouldFire;
  };

const getAutoSendFingerprint = (
  message: PersistedChatMessage | undefined,
): string | null => {
  if (!message || message.role !== "assistant") {
    return null;
  }

  const segments = [message.id];
  for (const part of message.parts) {
    if (typeof part !== "object" || !("type" in part)) {
      continue;
    }

    const type = typeof part.type === "string" ? part.type : "";
    const state =
      "state" in part && typeof part.state === "string" ? part.state : "";
    const toolCallId =
      "toolCallId" in part && typeof part.toolCallId === "string"
        ? part.toolCallId
        : "";
    const approved =
      "approval" in part &&
      typeof part.approval === "object" &&
      "approved" in part.approval &&
      typeof part.approval.approved === "boolean"
        ? String(part.approval.approved)
        : "";

    segments.push(`${type}:${toolCallId}:${state}:${approved}`);
  }

  return segments.join("|");
};

export type ChatThreadFetched = {
  chat: Chat<PersistedChatMessage>;
  /**
   * Persisted contextMatterIds for this thread, fresh from the
   * server. Consumers feed this into local picker state on mount;
   * subsequent changes flow back through `getContextMatterIds` on
   * the transport, not through this read.
   */
  contextMatterIds: string[];
  /**
   * Per-thread web-search opt-in. Mutated via PATCH /chat/threads/:id
   * with optimistic cache update; the next send-message reads the
   * persisted value to decide whether to expose the web_search +
   * fetch_url tools to the model.
   */
  webSearchEnabled: boolean;
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
    queryKey: chatKeys.thread(activeOrganizationId, {
      ...key,
      allowMissingThread: context.allowMissingThread,
      contextKind: getChatRuntimeContextKind(context),
    }),
    queryFn: async ({ client: queryClient }): Promise<ChatThreadFetched> => {
      const { messages, contextMatterIds, webSearchEnabled } =
        await fetchThreadMessages(key, {
          allowMissingThread: context.allowMissingThread,
        });

      const chat = new Chat<PersistedChatMessage>({
        generateId: uuidv7,
        messages,
        onError: (error) => {
          getAnalytics().captureError(error);
        },
        onFinish: ({ isError }) => {
          if (isError) {
            return;
          }

          void Promise.all([
            invalidateChatThread({ queryClient, threadRef: key }),
            invalidateGroupedChatThreads(queryClient),
          ]);
        },
        transport: new DefaultChatTransport({
          api: getChatApiPath(),
          credentials: "include",
          prepareSendMessagesRequest: ({
            body: requestBody,
            messages: nextMessages,
          }) => ({
            body: buildSendRequestBody({
              context,
              key,
              messages: nextMessages,
              requestBody,
            }),
          }),
        }),
        sendAutomaticallyWhen: createSendAutomaticallyPredicate(),
      });

      return { chat, contextMatterIds, webSearchEnabled };
    },
  });

export const groupedChatThreadsOptions = (activeOrganizationId: string) =>
  infiniteQueryOptions({
    queryKey: chatKeys.groupedThreads(activeOrganizationId),
    queryFn: async ({ pageParam, signal }): Promise<GroupedChatThreadsPage> =>
      await fetchGroupedChatThreads({ cursor: pageParam, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

export const invalidateGroupedChatThreads = async (queryClient: QueryClient) =>
  await queryClient.invalidateQueries({
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
