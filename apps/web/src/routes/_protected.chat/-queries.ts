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

import type {
  ChatUITools,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { hasApprovedActiveDocxEditAwaitingClientOutput } from "@/components/chat/chat-ui-tools";
import { env } from "@/env";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
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
  fileName: string;
};

type ActiveDecisionContext = {
  decisionId: string;
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
  getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
  /**
   * Matters this chat draws context from. The transport sends the
   * current value (an empty array means "no matters pinned"). The
   * server persists it on the thread and re-uses it on subsequent
   * turns; the picker UI calls back here on every change so the
   * next send carries the latest set.
   */
  getContextMatterIds?: (() => string[]) | undefined;
  getAnonymized?: (() => boolean) | undefined;
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

type ChatRuntimeContextKind = "active-docx-edit" | "active-file" | "plain";

const getChatRuntimeContextKind = (
  context: ChatThreadOptionsContext | undefined,
): ChatRuntimeContextKind => {
  if (context?.handleActiveDocxEditToolCall) {
    return "active-docx-edit";
  }

  if (context?.getActiveFile) {
    return "active-file";
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
}: {
  context: ChatThreadOptionsContext | undefined;
  key: ChatThreadKey;
  messages: PersistedChatMessage[];
}) => {
  const message = messages.at(-1);
  if (!message) {
    panic("Missing chat message");
  }

  const body: {
    activeDecision?: ActiveDecisionContext | undefined;
    activeFile?: ActiveFileContext | undefined;
    anonymized?: boolean | undefined;
    contextMatterIds?: string[] | undefined;
    message: PersistedChatMessage;
    threadId: string;
    userContext?: ChatUserContext | undefined;
    workspaceId?: string | undefined;
  } = {
    message,
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

  const contextMatterIds = context?.getContextMatterIds?.();
  if (contextMatterIds !== undefined) {
    body.contextMatterIds = contextMatterIds;
  }

  const anonymized = context?.getAnonymized?.();
  if (anonymized !== undefined) {
    body.anonymized = anonymized;
  }

  return body;
};

// Per-thread guard against empty-completion auto-resubmit storms.
// When a model returns finish_reason=stop with zero tokens (observed
// with cached prefixes on small Gemini variants), the AI SDK does
// not append a new assistant message, so the same tool-result tail
// keeps satisfying the predicate and useChat resubmits at ~1.5 Hz
// until the user reloads. Tracking the id of the message that last
// triggered an automatic send breaks the loop without affecting the
// legitimate post-tool-result resubmit. Id is more robust than
// length: deleting and re-adding a message reuses no id, so the
// predicate cannot accidentally lock out a future fire.
const createSendAutomaticallyPredicate = () => {
  let lastFiredMessageId: string | null = null;
  return ({ messages }: { messages: PersistedChatMessage[] }) => {
    if (hasApprovedActiveDocxEditAwaitingClientOutput({ messages })) {
      return false;
    }
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.id === lastFiredMessageId) {
      return false;
    }
    const shouldFire =
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages });
    if (shouldFire) {
      lastFiredMessageId = lastMessage.id;
    }
    return shouldFire;
  };
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
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- runtime getter callbacks configure the Chat transport but are intentionally not part of cache identity.
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.thread({
      ...key,
      allowMissingThread: context?.allowMissingThread,
      contextKind: getChatRuntimeContextKind(context),
    }),
    queryFn: async (): Promise<ChatThreadFetched> => {
      const { messages, contextMatterIds } = await fetchThreadMessages(key, {
        allowMissingThread: context?.allowMissingThread,
      });

      const chat = new Chat<PersistedChatMessage>({
        generateId: uuidv7,
        messages,
        transport: new DefaultChatTransport({
          api: getChatApiPath(),
          credentials: "include",
          prepareSendMessagesRequest: ({ messages: nextMessages }) => ({
            body: buildSendRequestBody({
              context,
              key,
              messages: nextMessages,
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
  threadId: string,
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
  threadId: string;
}) =>
  await queryClient.invalidateQueries({
    predicate: (query) =>
      matchesChatThreadAcrossScopes(query.queryKey, threadId),
  });
