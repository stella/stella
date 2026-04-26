import { Chat } from "@ai-sdk/react";
import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { panic } from "better-result";
import { v7 as uuidv7 } from "uuid";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { env } from "@/env";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { STALE_TIME } from "@/lib/consts";
import { APIError, toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { ChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";

type ActiveFileContext = {
  entityId: string;
  fileName: string;
};

type ChatThreadKey = ChatThreadRef;

type GroupedChatThreads = Awaited<ReturnType<typeof fetchGroupedChatThreads>>;

type ChatThreadOptionsContext = {
  allowMissingThread?: boolean | undefined;
  getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
  getUserContext?: (() => ChatUserContext) | undefined;
};

type ChatThreadQueryKey = ChatThreadRef & {
  allowMissingThread?: boolean | undefined;
};

type ChatThreadOptionsInput = QueryOptionsInput<
  ChatThreadKey,
  ChatThreadOptionsContext
>;

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
        ]
      : [
          ...chatKeys.all,
          "thread",
          key.scope,
          key.workspaceId,
          key.threadId,
          key.allowMissingThread ?? false,
        ],
};

const fetchThreadMessages = async (
  key: ChatThreadKey,
  {
    allowMissingThread = false,
  }: {
    allowMissingThread?: boolean | undefined;
  } = {},
): Promise<PersistedChatMessage[]> => {
  const response = await api.chat
    .threads({ threadId: key.threadId })
    .messages.get({
      query:
        key.scope === "workspace"
          ? { workspaceId: toSafeId<"workspace">(key.workspaceId) }
          : {},
    });

  if (response.error) {
    const error = toAPIError(response.error);

    if (allowMissingThread && APIError.is(error) && error.status === 404) {
      return [];
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

const buildSendRequestBody = ({
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
    activeFile?: ActiveFileContext | undefined;
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

  return body;
};

export const chatThreadOptions = ({ key, context }: ChatThreadOptionsInput) =>
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- runtime getter callbacks configure the Chat transport but are intentionally not part of cache identity.
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.thread({
      ...key,
      allowMissingThread: context?.allowMissingThread,
    }),
    queryFn: async () => {
      const messages = await fetchThreadMessages(key, {
        allowMissingThread: context?.allowMissingThread,
      });

      return new Chat<PersistedChatMessage>({
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
        sendAutomaticallyWhen:
          lastAssistantMessageIsCompleteWithApprovalResponses,
      });
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
