import { useQueryClient } from "@tanstack/react-query";

import type { REALTIME_EVENT_TYPE } from "@stll/api-contract";

import { firstNotificationsPageRefresh } from "@/lib/notification-queries";
import { useUserEventsSSE } from "@/lib/user-events-sse";

/**
 * The one user stream of a signed-in tab, mounted by the app shell so it is
 * open on every page whatever the tab shows or which features are on. It
 * carries the person's own events and the organization's content-free
 * fan-out, which `useUserEventsSSE` turns into refreshes of the firm-wide
 * lists. Mount it once: every call opens its own connection.
 */
export const useUserEventRefreshes = ({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}): void => {
  const queryClient = useQueryClient();
  useUserEventsSSE(organizationId, ({ type: eventType }) => {
    // The user channel carries a single event kind today; this bind makes a
    // second kind a compile error here instead of a silently ignored event.
    eventType satisfies typeof REALTIME_EVENT_TYPE.NEW_NOTIFICATION;
    return [
      firstNotificationsPageRefresh({ organizationId, queryClient, userId }),
    ];
  });
};
