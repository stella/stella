import { useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { REALTIME_EVENT_TYPE } from "@stll/api-contract";

import { activeChatRunsOptions } from "@/features/chat/active-runs";
import { firstNotificationsPageRefresh } from "@/lib/notification-queries";
import { useUserEventsSSE } from "@/lib/user-events-sse";
import type { UserEventRefresh } from "@/lib/user-events-sse";

/**
 * The one subscription to the signed-in user's own event stream, mounted by
 * the app shell. Each event kind names the queries it makes stale; they
 * refresh only where something observes them.
 */
export const useUserEventRefreshes = ({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}): void => {
  const queryClient = useQueryClient();

  const notifications = (): UserEventRefresh =>
    firstNotificationsPageRefresh({ organizationId, queryClient, userId });
  const activeChatRuns = (): UserEventRefresh => ({
    queryKey: activeChatRunsOptions({
      activeOrganizationId: organizationId,
      userId,
    }).queryKey,
  });

  useUserEventsSSE(organizationId, {
    onEvent: ({ type: eventType }) => {
      switch (eventType) {
        case REALTIME_EVENT_TYPE.NEW_NOTIFICATION:
          return [notifications()];
        case REALTIME_EVENT_TYPE.CHAT_RUNS_CHANGED:
          return [activeChatRuns()];
        default:
          eventType satisfies never;
          return panic("Unhandled user realtime event");
      }
    },
    onResync: () => [notifications(), activeChatRuns()],
  });
};
