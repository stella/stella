import { useRef } from "react";

import type { QueryKey } from "@tanstack/react-query";
import { hashKey, useQueryClient } from "@tanstack/react-query";

import {
  parseOrganizationRealtimeEvent,
  parseUserRealtimeEvent,
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
  USER_EVENT_READ,
  USER_EVENT_READS,
} from "@stll/api-contract";
import type { UserEventRead, UserRealtimeEvent } from "@stll/api-contract";
import { backoffDelay } from "@stll/concurrency/backoff-delay";

import { activeChatRunsOptions } from "@/features/chat/active-runs";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import {
  captureSessionQueryOwner,
  isObservedSessionQueryOwner,
} from "@/lib/account/auth-query-owner";
import { useObservedSessionQueryOwner } from "@/lib/account/use-observed-session-query-owner";
import { apiUrl } from "@/lib/api-url";
import { sessionOptions } from "@/lib/auth-query-options";
import { firstNotificationsPageRefresh } from "@/lib/notification-queries";
import { organizationEventQueryKeys } from "@/lib/organization/realtime.logic";
import { organizationResourceQueryActions } from "@/lib/workspace-realtime";
import { getRealtimeRefreshScheduler } from "@/lib/workspaces/realtime-refresh";
import type {
  ResourceQueryOwner,
  ResourceRefreshContext,
} from "@/lib/workspaces/resource-query-identity";

/** A query the user stream refreshes, and what to trim before it does. */
type UserEventRefresh = {
  queryKey: QueryKey;
  prepare?: () => void;
} & ResourceRefreshContext;

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
 * the same session. Mount it once (`useUserEventRefreshes`): every call opens
 * its own connection.
 */
const useUserEventsSSE = (
  { organizationId, userId }: { organizationId: string; userId: string },
  {
    onEvent,
    onResync,
  }: {
    onEvent: (event: UserRealtimeEvent) => UserEventRefresh[];
    /**
     * Everything the stream keeps fresh. Events sent while the stream was
     * down are lost, so every reopen after the first re-reads all of it.
     */
    onResync: (owner: ResourceQueryOwner) => UserEventRefresh[];
  },
): void => {
  const queryClient = useQueryClient();
  const realtimeRefresh = getRealtimeRefreshScheduler(queryClient);
  const observedOwner = useObservedSessionQueryOwner(queryClient);
  const connectionGap = useRef({ userId, organizationId, pending: false });
  const handleEvent = useLatestCallback(onEvent);
  const handleResync = useLatestCallback(onResync);

  useExternalSyncEffect(() => {
    const captureOwner = () => {
      const captured = captureSessionQueryOwner(queryClient);
      return captured?.userId === userId &&
        captured.organizationId === organizationId
        ? captured
        : undefined;
    };
    const initialOwner = captureOwner();
    if (
      connectionGap.current.userId !== userId ||
      connectionGap.current.organizationId !== organizationId
    ) {
      connectionGap.current = { userId, organizationId, pending: false };
    }
    const gap = connectionGap.current;
    if (initialOwner === undefined) {
      gap.pending = true;
    }
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let disposed = false;
    let hasOpened = false;
    let unsubscribeWaiter: (() => void) | undefined;

    const connect = (owner: ResourceQueryOwner) => {
      if (disposed) {
        return;
      }
      const stream = new EventSource(
        apiUrl("/notifications/events"),
        USER_SSE_EVENT_SOURCE_INIT,
      );
      source = stream;

      stream.addEventListener("open", () => {
        if (
          disposed ||
          source !== stream ||
          !isObservedSessionQueryOwner(queryClient, owner)
        ) {
          return;
        }
        consecutiveFailures = 0;
        // The browser's own retries and ours both land here; either way the
        // gap may have swallowed events. The first open re-reads nothing: the
        // queries were just fetched, and a second read would only double them.
        if (hasOpened || gap.pending) {
          for (const { queryKey, prepare, ...context } of handleResync(owner)) {
            realtimeRefresh.refresh(queryKey, prepare, { ...context, owner });
          }
          gap.pending = false;
        }
        hasOpened = true;
      });
      stream.addEventListener("message", (event: MessageEvent) => {
        if (disposed || source !== stream) {
          return;
        }
        const payload = jsonOrNull(String(event.data));
        const parsed = parseUserRealtimeEvent(payload);
        if (parsed) {
          for (const { queryKey, prepare, ...context } of handleEvent(parsed)) {
            realtimeRefresh.refresh(queryKey, prepare, { ...context, owner });
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
            realtimeRefresh.refresh(queryKey, undefined, { owner });
          }
          for (const {
            queryKey,
            ...context
          } of organizationResourceQueryActions({
            queryClient,
            organizationId,
            resources: [organizationEvent.resourceType],
            owner,
          })) {
            realtimeRefresh.refresh(queryKey, undefined, context);
          }
        }
      });
      stream.addEventListener("error", () => {
        if (disposed || source !== stream) {
          return;
        }
        // CONNECTING means the browser is retrying on its own.
        if (stream.readyState !== EventSource.CLOSED) {
          return;
        }
        stream.close();
        consecutiveFailures += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect(owner);
        }, reconnectDelayMs(consecutiveFailures));
      });
    };

    if (initialOwner !== undefined) {
      connect(initialOwner);
    } else {
      unsubscribeWaiter = queryClient.getQueryCache().subscribe((event) => {
        if (
          disposed ||
          event.query.queryHash !== hashKey(sessionOptions.queryKey)
        ) {
          return;
        }
        const owner = captureOwner();
        if (owner !== undefined) {
          unsubscribeWaiter?.();
          connect(owner);
        }
      });
    }

    return () => {
      disposed = true;
      unsubscribeWaiter?.();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      source?.close();
    };
  }, [
    handleEvent,
    handleResync,
    organizationId,
    userId,
    observedOwner,
    realtimeRefresh,
    queryClient,
  ]);
};

/**
 * The one user stream of a signed-in tab, mounted by the app shell so it is
 * open on every page whatever the tab shows or which features are on. It
 * carries the person's own events and the organization's content-free
 * fan-out, which `useUserEventsSSE` turns into refreshes of the firm-wide
 * lists. Each event kind names the queries it makes stale; they refresh only
 * where something observes them. Mount it once: every call opens its own
 * connection.
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
  // Rows carry the reader's read and pin states.
  const chatThreadLists = (): UserEventRefresh => ({
    queryKey: chatKeys.groupedThreadLists(organizationId, userId),
  });

  // Each open chat that ran on a computer reads its own count again.
  const backgroundTasks = (): UserEventRefresh => ({
    queryKey: chatKeys.backgroundTaskCounts(organizationId, userId),
  });

  // Each open chat reads its own queue again.
  const chatQueues = (): UserEventRefresh => ({
    queryKey: chatKeys.queues(organizationId, userId),
  });

  const refreshes = {
    [USER_EVENT_READ.ACTIVE_CHAT_RUNS]: activeChatRuns,
    [USER_EVENT_READ.CHAT_BACKGROUND_TASKS]: backgroundTasks,
    [USER_EVENT_READ.CHAT_QUEUES]: chatQueues,
    [USER_EVENT_READ.CHAT_THREADS]: chatThreadLists,
    [USER_EVENT_READ.NOTIFICATIONS]: notifications,
  } satisfies Record<UserEventRead, () => UserEventRefresh>;

  useUserEventsSSE(
    { organizationId, userId },
    {
      onEvent: ({ type }) =>
        USER_EVENT_READS[type].map((read) => refreshes[read]()),
      onResync: (owner) => [
        notifications(),
        activeChatRuns(),
        chatThreadLists(),
        backgroundTasks(),
        chatQueues(),
        ...organizationResourceQueryActions({
          queryClient,
          organizationId,
          resources: Object.values(RESOURCE_TYPE),
          owner,
        }),
        ...organizationEventQueryKeys(
          resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.CONTACT),
          organizationId,
        ).map((queryKey) => ({ queryKey })),
      ],
    },
  );
};

const jsonOrNull = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
