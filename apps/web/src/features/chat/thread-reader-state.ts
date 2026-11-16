import { useRef } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { CHAT_THREAD_READ_STATE } from "@stll/api-contract/chat";
import type {
  ChatThreadPinState,
  ChatThreadReadState,
} from "@stll/api-contract/chat";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { groupedChatThreadsOptions } from "@/features/chat/queries";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { WebApiRoutes } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";

type GroupedChatThreadsPage =
  WebApiRoutes["chat"]["threads"]["get"]["response"][200];

const threadScopeQuery = (threadRef: ChatThreadRef) =>
  threadRef.scope === "workspace"
    ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
    : {};

const pageThreads = (page: GroupedChatThreadsPage) => [
  ...page.global,
  ...page.workspaces.flatMap((workspace) => workspace.threads),
];

/** One thread's read state in cached list pages; undefined when no page holds it. */
const cachedReadStateIn = (
  pages: readonly GroupedChatThreadsPage[],
  threadId: string,
): ChatThreadReadState | undefined =>
  pages.flatMap(pageThreads).find((thread) => thread.id === threadId)
    ?.readState;

/** Every cached grouped thread list of the reader, with one thread's read state replaced. */
const writeCachedReadState = ({
  queryClient,
  queryKey,
  readState,
  threadId,
}: {
  queryClient: QueryClient;
  queryKey: readonly unknown[];
  readState: ChatThreadReadState;
  threadId: string;
}) => {
  queryClient.setQueriesData<InfiniteData<GroupedChatThreadsPage>>(
    { queryKey },
    (old) =>
      old === undefined
        ? old
        : {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              global: page.global.map((thread) =>
                thread.id === threadId ? { ...thread, readState } : thread,
              ),
              workspaces: page.workspaces.map((workspace) => ({
                ...workspace,
                threads: workspace.threads.map((thread) =>
                  thread.id === threadId ? { ...thread, readState } : thread,
                ),
              })),
            })),
          },
  );
};

type ReadStateChange = {
  readState: ChatThreadReadState;
  threadRef: ChatThreadRef;
};

const threadRoutes = (threadRef: ChatThreadRef) =>
  api.chat.threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) });

const patchReadState = async ({ readState, threadRef }: ReadStateChange) => {
  const response = await threadRoutes(threadRef)["read-state"].patch(
    { readState },
    { query: threadScopeQuery(threadRef) },
  );
  return unwrapApiResponse(response);
};

/**
 * A read-state write that shows in the reader's cached lists at once. The
 * server tells the reader's other devices and tabs through the user event
 * stream, whose refresh also corrects this tab if the write failed.
 */
const useReadStateMutation = (onError: (error: Error) => void) => {
  const queryClient = useQueryClient();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const listsKey = chatKeys.groupedThreadLists(activeOrganizationId, userId);
  return useMutation({
    mutationFn: patchReadState,
    onMutate: async ({ readState, threadRef }) => {
      await queryClient.cancelQueries({ queryKey: listsKey });
      writeCachedReadState({
        queryClient,
        queryKey: listsKey,
        readState,
        threadId: threadRef.threadId,
      });
    },
    onError: async (error) => {
      onError(error);
      await queryClient.invalidateQueries({
        queryKey: listsKey,
        refetchType: "active",
      });
    },
  });
};

/** The reader marking a chat read or unread from its menu. */
export const useSetChatThreadReadState = () => {
  const t = useTranslations();
  return useReadStateMutation((error) => {
    notifyUserError(error, t("errors.actionFailed"));
  });
};

type MarkReadWhileOpenOptions = {
  /** An answer still streams: it is read once it has settled. */
  isGenerating: boolean;
  /**
   * What the reader sees of the thread, such as its latest message id; null
   * before it has any. Each revision is marked at most once.
   */
  revision: string | null;
  /** A draft thread has no row to mark yet. */
  threadExists: boolean;
  threadRef: ChatThreadRef;
};

/**
 * Keep the open chat read: whenever the tab shows it with no answer
 * streaming, and the reader's cached list does not already say it is read,
 * mark it read. A chat no cached list holds is marked too, since its state is
 * unknown; a chat open in a hidden tab waits until the tab is shown.
 *
 * Each opened revision is marked at most once, whatever the outcome: a failed
 * mark is captured, and the list refresh that restores the unread row does not
 * send it again. A new answer (a new revision) or reopening the chat (a new
 * mount) marks it again.
 */
export const useMarkChatThreadReadWhileOpen = ({
  isGenerating,
  revision,
  threadExists,
  threadRef,
}: MarkReadWhileOpenOptions) => {
  const markedRevision = useRef<string | null>(null);
  const analytics = useAnalytics();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  // Primitives, so a caller's fresh ref object each render marks nothing.
  const { threadId } = threadRef;
  const workspaceId =
    threadRef.scope === "workspace" ? threadRef.workspaceId : null;
  const cachedView = queryView(
    useInfiniteQuery({
      ...groupedChatThreadsOptions({ activeOrganizationId, userId }),
      // Read only what the history surfaces already fetched.
      enabled: false,
      select: (data) => cachedReadStateIn(data.pages, threadId),
    }),
  );
  // A list that failed to load says nothing about this chat: unknown.
  const cachedReadState =
    cachedView.type === "items" ? cachedView.items : undefined;
  const { mutate: markRead } = useReadStateMutation((error) => {
    analytics.captureError(error, {
      fingerprintKey: "useMarkChatThreadReadWhileOpen:failure",
      scope: {
        type: "handler",
        handlerId: "useMarkChatThreadReadWhileOpen:failure",
      },
    });
  });

  useExternalSyncEffect(() => {
    const controller = new AbortController();
    const revisionKey = JSON.stringify([workspaceId, threadId, revision]);
    if (
      isGenerating ||
      !threadExists ||
      cachedReadState === CHAT_THREAD_READ_STATE.read ||
      markedRevision.current === revisionKey
    ) {
      return () => controller.abort();
    }
    const mark = () => {
      controller.abort();
      markedRevision.current = revisionKey;
      markRead({
        readState: CHAT_THREAD_READ_STATE.read,
        threadRef:
          workspaceId === null
            ? { scope: "global", threadId }
            : { scope: "workspace", threadId, workspaceId },
      });
    };
    if (document.visibilityState === "visible") {
      mark();
    } else {
      document.addEventListener(
        "visibilitychange",
        () => {
          if (document.visibilityState === "visible") {
            mark();
          }
        },
        { signal: controller.signal },
      );
    }
    return () => controller.abort();
  }, [
    cachedReadState,
    isGenerating,
    markRead,
    revision,
    threadExists,
    threadId,
    workspaceId,
  ]);
};

type PinStateChange = {
  pinState: ChatThreadPinState;
  threadRef: ChatThreadRef;
};

/** The one web writer of a chat's pin: the pinned and unpinned lists re-read on settle. */
export const useSetChatThreadPinState = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();

  return useMutation({
    mutationFn: async ({ pinState, threadRef }: PinStateChange) => {
      const response = await threadRoutes(threadRef)["pin-state"].patch(
        { pinState },
        { query: threadScopeQuery(threadRef) },
      );
      return unwrapApiResponse(response);
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.groupedThreadLists(activeOrganizationId, userId),
        refetchType: "active",
      });
    },
  });
};
