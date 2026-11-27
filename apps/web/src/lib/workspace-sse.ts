import { useRef } from "react";

import { hashKey, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { RESOURCE_TYPE, type WorkspaceRealtimeEvent } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";
import { useExternalSyncEffect, useLatestCallback } from "@stll/ui/effects";

import {
  captureSessionQueryOwner,
  isObservedSessionQueryOwner,
} from "@/lib/account/auth-query-owner";
import { useObservedSessionQueryOwner } from "@/lib/account/use-observed-session-query-owner";
import { useAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { sessionOptions } from "@/lib/auth-query-options";
import { detached } from "@/lib/detached";
import { notifyUserProblem } from "@/lib/errors/user-toast";
import {
  coalesceWorkspaceQueryActions,
  getWorkspaceRealtimeQueryActions,
  getWorkspaceReconnectQueryActions,
  isWorkspaceQueryKey,
  organizationResourceQueryActions,
  parseWorkspaceRealtimeMessage,
  WORKSPACE_REALTIME_QUERY_ACTION,
} from "@/lib/workspace-realtime";
import type { WorkspaceRealtimeQueryAction } from "@/lib/workspace-realtime";
import {
  connectWorkspaceStream,
  WORKSPACE_STREAM_ACCESS,
  workspaceStreamAccessFromStatus,
} from "@/lib/workspace-sse-connection.logic";
import type {
  WorkspaceStreamAccess,
  WorkspaceStreamHandlers,
} from "@/lib/workspace-sse-connection.logic";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { getRealtimeRefreshScheduler } from "@/lib/workspaces/realtime-refresh";
import { resourceRefreshIdentity } from "@/lib/workspaces/resource-query-identity";
import type { ResourceQueryOwner } from "@/lib/workspaces/resource-query-identity";
import { handleWorkspaceMutationEvent } from "@/lib/workspaces/workspace-mutation";

const WORKSPACE_SSE_EVENT_SOURCE_INIT = {
  withCredentials: true,
} satisfies EventSourceInit;

// Long enough for the stream's access check, short enough that a hung probe
// only delays the next reconnect attempt.
const WORKSPACE_STREAM_PROBE_TIMEOUT_MS = 10_000;
const WORKSPACE_INVALIDATION_BATCH_MS = 16;

type QueryActionBatch = {
  add: (actions: WorkspaceRealtimeQueryAction[]) => void;
  cancel: () => void;
};

/** Coalesces a stream burst so each cache key is touched once per frame. */
export const createWorkspaceQueryActionBatch = (
  apply: (actions: WorkspaceRealtimeQueryAction[]) => void,
  schedule: (callback: () => void, delayMs: number) => () => void = (
    callback,
    delayMs,
  ) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
): QueryActionBatch => {
  const pending = new Map<object, Map<string, WorkspaceRealtimeQueryAction>>();
  let cancelScheduled: (() => void) | null = null;

  const flush = () => {
    cancelScheduled?.();
    cancelScheduled = null;
    const actions = [...pending.values()].flatMap((entries) => [
      ...entries.values(),
    ]);
    pending.clear();
    if (actions.length === 0) {
      return;
    }
    apply(coalesceWorkspaceQueryActions(actions));
  };

  return {
    add: (actions) => {
      if (actions.length === 0) {
        return;
      }
      for (const action of actions) {
        // Re-insert so the flush keeps the order of each key's last action.
        const key = `${action.type}:${hashKey(action.queryKey)}`;
        const identity = resourceRefreshIdentity(
          action.type === "invalidate" ? action : {},
        );
        const entries =
          pending.get(identity) ??
          new Map<string, WorkspaceRealtimeQueryAction>();
        entries.delete(key);
        entries.set(key, { ...action });
        pending.set(identity, entries);
      }
      cancelScheduled ??= schedule(flush, WORKSPACE_INVALIDATION_BATCH_MS);
    },
    cancel: () => {
      // Preserve the last event's freshness when navigation ends a stream
      // before its scheduled batch runs.
      flush();
    },
  };
};

type UseWorkspaceSSEOptions = {
  onEvent?: (event: WorkspaceRealtimeEvent) => void;
  identity: { userId: string; organizationId: string };
};

export const applyWorkspaceRealtimeQueryActions = (
  queryClient: QueryClient,
  actions: WorkspaceRealtimeQueryAction[],
) => {
  const realtimeRefresh = getRealtimeRefreshScheduler(queryClient);
  for (const action of actions) {
    switch (action.type) {
      case WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE:
        realtimeRefresh.refresh(action.queryKey, undefined, action);
        break;
      case WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX:
        queryClient.removeQueries({ queryKey: action.queryKey, exact: false });
        break;
      default:
        action satisfies never;
        panic(`Unhandled action: ${String(action)}`);
    }
  }
};

const getWorkspaceSSEUrl = (workspaceId: string) =>
  apiUrl(`/workspaces/${workspaceId}/events`);

/**
 * Ask the stream URL why the browser gave up on it. The response headers are
 * all this needs: the request is aborted as soon as they arrive, so a stream
 * that would have opened is never read.
 */
const probeWorkspaceStreamAccess = async (
  workspaceId: string,
): Promise<WorkspaceStreamAccess> => {
  const controller = new AbortController();
  const response = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(getWorkspaceSSEUrl(workspaceId), {
        credentials: "include",
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
        timeoutMs: WORKSPACE_STREAM_PROBE_TIMEOUT_MS,
      }),
  );
  controller.abort();
  // A request that never got an answer says nothing about access, so it is
  // treated as the outage it most likely is.
  return response.isOk()
    ? workspaceStreamAccessFromStatus(response.value.status)
    : WORKSPACE_STREAM_ACCESS.AVAILABLE;
};

/** Each source keeps its own handlers; a replaced or retired source cannot act. */
const createWorkspaceEventSourceFactory = ({
  workspaceId,
  isCurrent,
  onAcceptedOpen,
}: {
  workspaceId: string;
  isCurrent: () => boolean;
  onAcceptedOpen: () => void;
}) => {
  let currentStream: EventSource | undefined;
  return ({ onOpen, onMessage, onError }: WorkspaceStreamHandlers) => {
    const stream = new EventSource(
      getWorkspaceSSEUrl(workspaceId),
      WORKSPACE_SSE_EVENT_SOURCE_INIT,
    );
    currentStream = stream;
    const canAct = () => currentStream === stream && isCurrent();
    stream.addEventListener("open", () => {
      if (canAct()) {
        onOpen();
        onAcceptedOpen();
      }
    });
    stream.addEventListener("message", (event: MessageEvent) => {
      if (canAct()) {
        onMessage(String(event.data));
      }
    });
    stream.addEventListener("error", () => {
      if (canAct()) {
        onError();
      }
    });
    return {
      isClosed: () => stream.readyState === EventSource.CLOSED,
      close: () => {
        if (currentStream === stream) {
          currentStream = undefined;
        }
        stream.close();
      },
    };
  };
};

type WorkspaceSubscriptionOptions = {
  queryClient: QueryClient;
  workspaceId: string;
  identity: UseWorkspaceSSEOptions["identity"];
  gap: { pending: boolean };
  onParsedEvent: (
    event: WorkspaceRealtimeEvent,
    owner: ResourceQueryOwner,
  ) => WorkspaceRealtimeQueryAction[];
  onReconnect: (owner: ResourceQueryOwner) => void;
  onOutage: () => void;
  onAccessEnded: (context: {
    owner: ResourceQueryOwner;
    workspaceId: string;
  }) => Promise<void>;
};

/** One captured subscription owns its waiter, stream, pending batch and teardown. */
const subscribeOwnedWorkspace = ({
  queryClient,
  workspaceId,
  identity: { userId, organizationId },
  gap,
  onParsedEvent,
  onReconnect,
  onOutage,
  onAccessEnded,
}: WorkspaceSubscriptionOptions) => {
  const captureOwner = () => {
    const captured = captureSessionQueryOwner(queryClient);
    return captured?.userId === userId &&
      captured.organizationId === organizationId
      ? captured
      : undefined;
  };
  const initialOwner = captureOwner();
  if (initialOwner === undefined) {
    gap.pending = true;
  }
  let disposed = false;
  let disconnect: (() => void) | undefined;
  let unsubscribeWaiter: (() => void) | undefined;
  const connect = (owner: ResourceQueryOwner) => {
    const isCurrentConnection = () =>
      !disposed && isObservedSessionQueryOwner(queryClient, owner);
    // One batch per connection: its cleanup applies what the stream delivered
    // before navigation ended it.
    const actionBatch = createWorkspaceQueryActionBatch((actions) => {
      if (isObservedSessionQueryOwner(queryClient, owner)) {
        applyWorkspaceRealtimeQueryActions(queryClient, actions);
      }
    });
    const disconnectStream = connectWorkspaceStream({
      openSource: createWorkspaceEventSourceFactory({
        workspaceId,
        isCurrent: isCurrentConnection,
        onAcceptedOpen: () => {
          if (gap.pending) {
            onReconnect(owner);
            gap.pending = false;
          }
        },
      }),
      isOnline: () => navigator.onLine,
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => {
          clearTimeout(timer);
        };
      },
      probeAccess: (settle) => {
        detached(
          probeWorkspaceStreamAccess(workspaceId).then(settle),
          "workspace-stream.probe-access",
        );
      },
      onMessage: (data) => {
        if (!isCurrentConnection()) {
          return;
        }
        const parsed = parseWorkspaceRealtimeMessage(data);
        if (parsed) {
          handleWorkspaceMutationEvent(queryClient, parsed, () => {
            if (isCurrentConnection()) {
              actionBatch.add(onParsedEvent(parsed, owner));
            }
          });
        }
      },
      onOutage: () => {
        if (isCurrentConnection()) {
          onOutage();
        }
      },
      onAccessEnded: () => {
        if (isCurrentConnection()) {
          detached(
            onAccessEnded({ owner, workspaceId }),
            "workspace-stream.leave-ended-matter",
          );
        }
      },
      onReconnected: () => onReconnect(owner),
    });
    return () => {
      actionBatch.cancel();
      disconnectStream();
    };
  };
  if (initialOwner !== undefined) {
    disconnect = connect(initialOwner);
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
        disconnect = connect(owner);
      }
    });
  }
  return () => {
    disposed = true;
    unsubscribeWaiter?.();
    disconnect?.();
  };
};

/**
 * Subscribe to workspace-scoped SSE events and apply their validated React
 * Query cache actions.
 *
 * When the matter refuses the stream (the caller's access to it ended), the
 * hook stops reconnecting, drops the matter's cached data, and leaves for the
 * matter list. Cleans up on unmount or when workspaceId changes.
 */
export const useWorkspaceSSE = (
  workspaceId: string,
  options: UseWorkspaceSSEOptions,
) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const observedOwner = useObservedSessionQueryOwner(queryClient);
  const connectionGap = useRef({
    workspaceId,
    userId: options.identity.userId,
    organizationId: options.identity.organizationId,
    pending: false,
  });
  const navigate = useNavigate();
  const t = useTranslations();
  const realtimeRefresh = getRealtimeRefreshScheduler(queryClient);

  const handleParsedEvent = useLatestCallback(
    (
      event: WorkspaceRealtimeEvent,
      owner: ResourceQueryOwner,
    ): WorkspaceRealtimeQueryAction[] => {
      options.onEvent?.(event);
      return getWorkspaceRealtimeQueryActions(event, {
        workspaceId,
        queryClient,
        owner,
      });
    },
  );
  const refreshAfterReconnect = useLatestCallback(
    (owner: ResourceQueryOwner) => {
      for (const action of getWorkspaceReconnectQueryActions({
        workspaceId,
        queryClient,
        owner,
      })) {
        switch (action.type) {
          case WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE:
            detached(
              realtimeRefresh.invalidateImmediately(action.queryKey, action),
              "sse.reconnect-invalidate",
            );
            break;
          case WORKSPACE_REALTIME_QUERY_ACTION.REMOVE_PREFIX:
            queryClient.removeQueries({
              queryKey: action.queryKey,
              exact: false,
            });
            break;
          default:
            action satisfies never;
            panic(`Unhandled reconnect action: ${String(action)}`);
        }
      }
    },
  );
  const captureConnectionOutage = useLatestCallback(() => {
    analytics.captureError(
      // Stable message: the workspace id adds nothing to grouping and the
      // failure is the same defect regardless of workspace.
      new Error("SSE connection failed to re-establish"),
      {
        fingerprintKey: "useWorkspaceSSE:Error",
        scope: { type: "handler", handlerId: "useWorkspaceSSE:Error" },
      },
    );
  });
  const leaveEndedMatter = useLatestCallback(
    async ({
      owner,
      workspaceId: endedWorkspaceId,
    }: {
      owner: ResourceQueryOwner;
      workspaceId: string;
    }) => {
      notifyUserProblem(t("errors.matterNotFound"));
      // Leave first: dropping the cache while the matter's views are still
      // mounted would only make them refetch into the same refusal.
      await navigate({ to: "/workspaces", replace: true });
      if (!isObservedSessionQueryOwner(queryClient, owner)) {
        return;
      }
      queryClient.removeQueries({
        predicate: (query) =>
          isWorkspaceQueryKey(query.queryKey, endedWorkspaceId),
      });
      await realtimeRefresh.invalidateImmediately(workspacesKeys.all, {
        owner,
      });
      if (owner.organizationId !== null) {
        for (const action of organizationResourceQueryActions({
          queryClient,
          organizationId: owner.organizationId,
          resources: [RESOURCE_TYPE.WORKSPACE],
          owner,
        })) {
          await realtimeRefresh.invalidateImmediately(action.queryKey, action);
        }
      }
    },
  );

  useExternalSyncEffect(() => {
    if (
      connectionGap.current.workspaceId !== workspaceId ||
      connectionGap.current.userId !== options.identity.userId ||
      connectionGap.current.organizationId !== options.identity.organizationId
    ) {
      connectionGap.current = {
        workspaceId,
        userId: options.identity.userId,
        organizationId: options.identity.organizationId,
        pending: false,
      };
    }
    return subscribeOwnedWorkspace({
      queryClient,
      workspaceId,
      identity: {
        userId: options.identity.userId,
        organizationId: options.identity.organizationId,
      },
      gap: connectionGap.current,
      onParsedEvent: handleParsedEvent,
      onReconnect: refreshAfterReconnect,
      onOutage: captureConnectionOutage,
      onAccessEnded: leaveEndedMatter,
    });
  }, [
    queryClient,
    workspaceId,
    observedOwner,
    options.identity.userId,
    options.identity.organizationId,
    captureConnectionOutage,
    handleParsedEvent,
    leaveEndedMatter,
    refreshAfterReconnect,
  ]);
};
