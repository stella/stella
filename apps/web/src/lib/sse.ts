import { useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import type { WorkspaceRealtimeEvent } from "@stll/api-contract";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { detached } from "@/lib/detached";
import {
  getWorkspaceRealtimeQueryActions,
  parseWorkspaceRealtimeMessage,
  WORKSPACE_REALTIME_QUERY_ACTION,
} from "@/lib/workspace-realtime";

const WORKSPACE_SSE_EVENT_SOURCE_INIT = {
  withCredentials: true,
} satisfies EventSourceInit;

// The browser stops reconnecting (readyState CLOSED) on a non-2xx response,
// a wrong content type, or a network change — states a fresh EventSource
// usually recovers from. Re-establish with capped exponential backoff and
// escalate to telemetry once per outage episode, only after several
// consecutive failures while the browser reports itself online: a laptop
// waking from sleep should reconnect quietly, not page.
const SSE_RECONNECT_BASE_DELAY_MS = 1000;
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;
const SSE_ESCALATE_AFTER_FAILURES = 5;

const sseReconnectDelayMs = (failures: number): number =>
  Math.min(
    SSE_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1),
    SSE_RECONNECT_MAX_DELAY_MS,
  );

type UseWorkspaceSSEOptions = {
  onEvent?: (event: WorkspaceRealtimeEvent) => void;
};

const getWorkspaceSSEUrl = (workspaceId: string) =>
  apiUrl(`/workspaces/${workspaceId}/events`);

/**
 * Subscribe to workspace-scoped SSE events and apply their validated React
 * Query cache actions.
 *
 * The native EventSource retry covers transient drops; once the browser
 * gives up (readyState CLOSED) a new source is created with capped backoff.
 * Cleans up on unmount or when workspaceId changes.
 */
export const useWorkspaceSSE = (
  workspaceId: string,
  options: UseWorkspaceSSEOptions = {},
) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();

  const handleParsedEvent = useLatestCallback(
    (event: WorkspaceRealtimeEvent) => {
      options.onEvent?.(event);

      const actions = getWorkspaceRealtimeQueryActions(event, workspaceId);
      for (const action of actions) {
        switch (action.type) {
          case WORKSPACE_REALTIME_QUERY_ACTION.INVALIDATE:
            detached(
              queryClient.invalidateQueries({ queryKey: action.queryKey }),
              "sse.invalidate",
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
            panic(`Unhandled action: ${String(action)}`);
        }
      }
    },
  );
  const captureConnectionOutage = useLatestCallback(() => {
    analytics.captureError(
      // Stable message: the workspace id adds nothing to grouping and the
      // failure is the same defect regardless of workspace.
      new Error("SSE connection failed to re-establish"),
    );
  });

  useExternalSyncEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    // Offline failures back off but never count toward the outage capture:
    // they would either trip it on the first failure after coming back
    // online, or overshoot the threshold so a real outage never equals it.
    let consecutiveOnlineFailures = 0;
    let disposed = false;

    const handleMessage = (event: MessageEvent) => {
      const parsed = parseWorkspaceRealtimeMessage(String(event.data));
      if (!parsed) {
        return;
      }

      handleParsedEvent(parsed);
    };

    const connect = () => {
      const stream = new EventSource(
        getWorkspaceSSEUrl(workspaceId),
        WORKSPACE_SSE_EVENT_SOURCE_INIT,
      );
      source = stream;

      const handleOpen = () => {
        consecutiveFailures = 0;
        consecutiveOnlineFailures = 0;
      };

      const handleError = () => {
        // readyState CONNECTING means the browser is retrying on its own;
        // only a fully closed source needs our reconnect loop.
        if (stream.readyState !== EventSource.CLOSED || disposed) {
          return;
        }
        stream.close();
        consecutiveFailures += 1;
        if (navigator.onLine) {
          consecutiveOnlineFailures += 1;
          if (consecutiveOnlineFailures === SSE_ESCALATE_AFTER_FAILURES) {
            captureConnectionOutage();
          }
        } else {
          consecutiveOnlineFailures = 0;
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, sseReconnectDelayMs(consecutiveFailures));
      };

      stream.addEventListener("open", handleOpen);
      stream.addEventListener("message", handleMessage);
      stream.addEventListener("error", handleError);
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      source?.close();
    };
  }, [workspaceId, captureConnectionOutage, handleParsedEvent]);
};
