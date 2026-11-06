import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";

import {
  parseOrganizationRealtimeEvent,
  parseUserRealtimeEvent,
} from "@stll/api-contract";
import type {
  REALTIME_EVENT_TYPE,
  UserRealtimeEvent,
} from "@stll/api-contract";
import { backoffDelay } from "@stll/concurrency/backoff-delay";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { apiUrl } from "@/lib/api-url";
import { firstNotificationsPageRefresh } from "@/lib/notification-queries";
import { organizationEventQueryKeys } from "@/lib/organization/realtime.logic";
import { getRealtimeRefreshScheduler } from "@/lib/workspaces/realtime-refresh";

const USER_SSE_EVENT_SOURCE_INIT = {
  withCredentials: true,
} satisfies EventSourceInit;

/**
 * The browser gives up reconnecting (readyState CLOSED) on a non-2xx response,
 * a wrong content type, or a network change. Re-establish with capped
 * exponential backoff, mirroring the workspace stream.
 */
const SSE_RECONNECT_BASE_DELAY_MS = 1000;
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;

const reconnectDelayMs = (failures: number): number =>
  backoffDelay(Math.max(0, failures - 1), {
    baseMs: SSE_RECONNECT_BASE_DELAY_MS,
    maxMs: SSE_RECONNECT_MAX_DELAY_MS,
  });

/**
 * Subscribe to the signed-in user's own event stream, for one organization.
 *
 * Separate from the workspace stream on purpose: this one follows the person,
 * not the matter they happen to have open, so the bell keeps working on
 * routes that have no workspace at all. Events are content-free — they say
 * "your notifications changed", and the handler re-reads through the ordinary
 * authorized endpoint.
 *
 * `organizationId` never travels in the URL: the server reads the firm from
 * the session, which is the only source allowed to name it. It is this hook's
 * key instead — the server binds a connection to the active firm when it
 * opens, so a stream opened before an in-app switch would keep delivering the
 * firm the reader left. Tearing down and reopening on the change is what makes
 * the badge follow the switch, the same way the workspace stream reopens on
 * `workspaceId`.
 *
 * Reconnects are deliberately quiet here: an outage costs a delayed badge, not
 * lost data, and the workspace stream already reports connection failures for
 * the same session.
 */
const useUserEventsSSE = (
  organizationId: string,
  onEvent: (event: UserRealtimeEvent) => {
    queryKey: QueryKey;
    prepare?: () => void;
  }[],
): void => {
  const queryClient = useQueryClient();
  const realtimeRefresh = getRealtimeRefreshScheduler(queryClient);
  const handleEvent = useLatestCallback(onEvent);

  useExternalSyncEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let disposed = false;

    const connect = () => {
      const stream = new EventSource(
        apiUrl("/notifications/events"),
        USER_SSE_EVENT_SOURCE_INIT,
      );
      source = stream;

      stream.addEventListener("open", () => {
        consecutiveFailures = 0;
      });
      stream.addEventListener("message", (event: MessageEvent) => {
        const payload = jsonOrNull(String(event.data));
        const parsed = parseUserRealtimeEvent(payload);
        if (parsed) {
          for (const { queryKey, prepare } of handleEvent(parsed)) {
            realtimeRefresh.refresh(queryKey, prepare);
          }
          return;
        }
        // The organization's own fan-out rides this stream too, so lists
        // shared by the whole firm refresh on pages with no matter open.
        const organizationEvent = parseOrganizationRealtimeEvent(payload);
        if (organizationEvent) {
          for (const queryKey of organizationEventQueryKeys(
            organizationEvent,
            organizationId,
          )) {
            realtimeRefresh.refresh(queryKey);
          }
        }
      });
      stream.addEventListener("error", () => {
        // CONNECTING means the browser is retrying on its own.
        if (stream.readyState !== EventSource.CLOSED || disposed) {
          return;
        }
        stream.close();
        consecutiveFailures += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs(consecutiveFailures));
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      source?.close();
    };
  }, [handleEvent, organizationId, realtimeRefresh]);
};

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

const jsonOrNull = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
