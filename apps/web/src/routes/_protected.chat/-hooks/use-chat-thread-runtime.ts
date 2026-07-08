import { useQueryClient } from "@tanstack/react-query";

import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import {
  acquireChatRuntime,
  type ChatRuntime,
  type ChatThreadFetched,
  type ChatThreadOptionsContext,
} from "@/routes/_protected.chat/-queries";

type UseChatThreadRuntimeArgs = {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext | undefined;
  /** The pure-data result of `useSuspenseQuery(chatThreadOptions(...))`. */
  data: ChatThreadFetched;
  key: ChatThreadRef;
};

/**
 * Resolve the live `ChatRuntime` for a mounted thread surface.
 *
 * `chatThreadOptions` only ever fetches pure thread data (see its docs),
 * so a route loader can prefetch it without any component mounted. The
 * runtime — the streaming TanStack `ChatClient` whose fetcher closes over
 * THIS surface's live `context` getters — is built here, at the point a
 * real component renders with real getters, and shared through
 * `acquireChatRuntime`'s module-level registry so:
 *   - navigating away from a streaming thread and back reattaches to the
 *     SAME runtime with the stream still going (the registry entry
 *     outlives this component's mount/unmount), and
 *   - a thread whose stream was started by the `/chat` route-handoff
 *     sender (before this component ever mounted) is picked up here
 *     instead of a second, competing runtime being built.
 *
 * Called on every render (not gated behind `useState`/effects):
 * `acquireChatRuntime` is a cheap registry lookup on every call after the
 * first, so this stays correct if `context`'s getters change identity
 * across renders without needing extra synchronization. When a background
 * refetch (window-refocus staleness, cross-tab invalidation) delivers
 * `data` with a newer freshness signal to an IDLE thread, the acquire
 * call reconciles: the runtime is rebuilt from the fresh messages (new
 * identity, so `useChatSession`'s seeded paging state resets too). A busy
 * (streaming) runtime is never rebuilt — see `acquireChatRuntime`.
 */
export const useChatThreadRuntime = ({
  activeOrganizationId,
  context,
  data,
  key,
}: UseChatThreadRuntimeArgs): ChatRuntime => {
  const queryClient = useQueryClient();

  return acquireChatRuntime({
    activeOrganizationId,
    context,
    data,
    key,
    queryClient,
  });
};
