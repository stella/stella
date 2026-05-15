import { Chat } from "@ai-sdk/react";
import { queryOptions } from "@tanstack/react-query";
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
import { env } from "@/env";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";
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

type GroupedChatThreads = Awaited<ReturnType<typeof fetchGroupedChatThreads>>;

const APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME = "apply-active-docx-edits";
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

type ChatThreadQueryKey = ChatThreadRef & {
  allowMissingThread?: boolean | undefined;
  contextKind?: ChatRuntimeContextKind | undefined;
};

type ChatThreadOptionsInput = QueryOptionsInput<
  ChatThreadKey,
  ChatThreadOptionsContext
>;

type ChatRuntimeContextKind =
  | "active-docx-edit"
  | "active-external"
  | "active-file"
  | "plain";

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
  groupedThreads: () => [...chatKeys.all, "threads", "grouped"],
  thread: (key: ChatThreadQueryKey) =>
    key.scope === "global"
      ? [
          ...chatKeys.all,
          "thread",
          key.scope,
          key.threadId,
          key.allowMissingThread ?? false,
          key.contextKind ?? "plain",
          CHAT_TRANSPORT_VERSION,
        ]
      : [
          ...chatKeys.all,
          "thread",
          key.scope,
          key.workspaceId,
          key.threadId,
          key.allowMissingThread ?? false,
          key.contextKind ?? "plain",
          CHAT_TRANSPORT_VERSION,
        ],
};

type ThreadFetch = {
  messages: PersistedChatMessage[];
  contextMatterIds: string[];
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
      return { messages: [], contextMatterIds: [] };
    }

    throw error;
  }

  return response.data;
};

const fetchGroupedChatThreads = async () => {
  const response = await api.chat.threads.get();

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};

const getChatApiPath = () => `${env.VITE_API_URL}/v1/chat`;

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
};

export const chatThreadOptions = ({ key, context }: ChatThreadOptionsInput) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.thread({
      ...key,
      allowMissingThread: context.allowMissingThread,
      contextKind: getChatRuntimeContextKind(context),
    }),
    queryFn: async ({ client: queryClient }): Promise<ChatThreadFetched> => {
      const { messages, contextMatterIds } = await fetchThreadMessages(key, {
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

      return { chat, contextMatterIds };
    },
  });

export const groupedChatThreadsOptions = () =>
  queryOptions({
    queryKey: chatKeys.groupedThreads(),
    queryFn: async (): Promise<GroupedChatThreads> =>
      await fetchGroupedChatThreads(),
  });

export const invalidateGroupedChatThreads = async (queryClient: QueryClient) =>
  await queryClient.invalidateQueries({
    queryKey: chatKeys.groupedThreads(),
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
        queryKey.at(1) !== "thread" ||
        queryKey.at(2) !== threadRef.scope
      ) {
        return false;
      }

      if (threadRef.scope === "global") {
        return queryKey.at(3) === threadRef.threadId;
      }

      return (
        queryKey.at(3) === threadRef.workspaceId &&
        queryKey.at(4) === threadRef.threadId
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
  if (queryKey.at(0) !== "chat" || queryKey.at(1) !== "thread") {
    return false;
  }
  const scope = queryKey.at(2);
  if (scope === "global") {
    return queryKey.at(3) === threadId;
  }
  if (scope === "workspace") {
    return queryKey.at(4) === threadId;
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
