import { Chat } from "@ai-sdk/react";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { getChatActorConfig } from "@stella/rivet/actors/chat-actor-config";

import {
  RivetChatTransport,
  type UserContext,
} from "@/lib/ai-sdk/rivet-transport";
import { rivet } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { sessionOptions } from "@/routes/-queries";

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

export const chatThreadOptions = (opts: {
  threadId: string;
  queryClient: QueryClient;
  workspaceId?: string;
  getModelId?: () => string | null;
  userContext?: UserContext;
}) =>
  queryOptions({
    staleTime: STALE_TIME.FIVETEEN.MINUTES,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: chatKeys.thread(opts.threadId),
    queryFn: async () => {
      const sessionData =
        await opts.queryClient.ensureQueryData(sessionOptions);

      if (!sessionData?.session.activeOrganizationId) {
        throw new Error("No active organization");
      }

      const actorConfig = getChatActorConfig({
        type: "vanilla",
        organizationId: sessionData.session.activeOrganizationId,
        userId: sessionData.session.userId,
        authToken: sessionData.session.token,
      });

      const handle = rivet.chat.getOrCreate(...actorConfig);
      const connection = handle.connect();

      const initialMessages = await connection.getMessages({
        threadId: opts.threadId,
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: opts.threadId,
        workspaceId: opts.workspaceId,
        getModelId: opts.getModelId,
        userContext: opts.userContext,
      });

      return new Chat({
        messages: initialMessages,
        transport,
      });
    },
  });

export const chatThreadsOptions = (queryClient: QueryClient) =>
  queryOptions({
    queryKey: chatKeys.threads,
    queryFn: async () => {
      const sessionData = await queryClient.ensureQueryData(sessionOptions);

      if (!sessionData?.session.activeOrganizationId) {
        throw new Error("No active organization");
      }

      const actorConfig = getChatActorConfig({
        type: "vanilla",
        organizationId: sessionData.session.activeOrganizationId,
        userId: sessionData.session.userId,
        authToken: sessionData.session.token,
      });

      const handle = rivet.chat.getOrCreate(...actorConfig);
      const connection = handle.connect();

      return connection.getThreads();
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
        throw new Error("No active organization");
      }

      const actorConfig = getChatActorConfig({
        type: "vanilla",
        organizationId: sessionData.session.activeOrganizationId,
        userId: sessionData.session.userId,
        authToken: sessionData.session.token,
      });

      const handle = rivet.chat.getOrCreate(...actorConfig);
      const connection = handle.connect();

      return connection.getThreadsByWorkspace({ workspaceId });
    },
  });
