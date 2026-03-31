import { Chat } from "@ai-sdk/react";
import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { panic } from "better-result";
import type { ActorConn } from "rivetkit/client";

import { getChatActorConfig } from "@stella/rivet/actors/chat-actor-config";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";
import type {
  ActiveFileContext,
  ProcessedAttachment,
  UserContext,
} from "@/lib/ai-sdk/rivet-transport";
import { RivetChatTransport } from "@/lib/ai-sdk/rivet-transport";
import type { ChatActor } from "@/lib/api";
import { rivet } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import type { QueryOptionsInput } from "@/lib/react-query";
import { sessionOptions } from "@/routes/-queries";

type ChatActorConnection = ActorConn<ChatActor>;

export const chatKeys = {
  all: ["chat"],
  thread: (threadId: string) => [...chatKeys.all, "thread", threadId],
  threads: ["chat", "threads"],
  workspaceThreads: (workspaceId: string) => [
    ...chatKeys.all,
    "threads",
    workspaceId,
  ],
};

type ChatThreadOptionsInput = QueryOptionsInput<
  { threadId: string },
  {
    connection: ChatActorConnection;
    workspaceId?: string | undefined;
    decisionId?: string | undefined;
    getModelId?: (() => string | null) | undefined;
    userContext?: UserContext | undefined;
    getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
  }
>;

export const chatThreadOptions = ({ key, context }: ChatThreadOptionsInput) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.thread(key.threadId),
    queryFn: async () => {
      const initialMessages = await context.connection.getMessages({
        threadId: key.threadId,
      });

      const transport = new RivetChatTransport({
        connection: context.connection,
        threadId: key.threadId,
        workspaceId: context.workspaceId,
        decisionId: context.decisionId,
        getModelId: context.getModelId,
        userContext: context.userContext,
        getActiveFile: context.getActiveFile,
      });

      // SAFETY: messages from the actor are structurally
      // ChatMessage — narrowing adds typed tool parts.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const messages = initialMessages as ChatMessage[];
      const chat = new Chat<ChatMessage>({
        messages,
        transport,
        sendAutomaticallyWhen:
          lastAssistantMessageIsCompleteWithApprovalResponses,
      });

      return Object.assign(chat, {
        /** Queue attachments for the next message. */
        setAttachments: (atts: ProcessedAttachment[]) => {
          transport.pendingAttachments = atts;
        },
      });
    },
  });

export const chatThreadsOptions = (queryClient: QueryClient) =>
  queryOptions({
    queryKey: chatKeys.threads,
    queryFn: async () => {
      const sessionData = await queryClient.ensureQueryData(sessionOptions);

      if (!sessionData?.session.activeOrganizationId) {
        panic("No active organization");
      }

      const actorConfig = getChatActorConfig({
        type: "vanilla",
        organizationId: sessionData.session.activeOrganizationId,
        userId: sessionData.session.userId,
        authToken: sessionData.session.token,
      });

      const handle = rivet.chat.getOrCreate(...actorConfig);

      return handle.getThreads();
    },
  });

export const chatWorkspaceThreadsOptions = (
  workspaceId: string,
  queryClient: QueryClient,
) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.workspaceThreads(workspaceId),
    queryFn: async () => {
      const sessionData = await queryClient.ensureQueryData(sessionOptions);

      if (!sessionData?.session.activeOrganizationId) {
        panic("No active organization");
      }

      const actorConfig = getChatActorConfig({
        type: "vanilla",
        organizationId: sessionData.session.activeOrganizationId,
        userId: sessionData.session.userId,
        authToken: sessionData.session.token,
      });

      const handle = rivet.chat.getOrCreate(...actorConfig);

      return handle.getThreadsByWorkspace({ workspaceId });
    },
  });
