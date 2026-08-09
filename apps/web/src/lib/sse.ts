import { useQueryClient } from "@tanstack/react-query";

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

type UseWorkspaceSSEOptions = {
  onEvent?: (event: WorkspaceRealtimeEvent) => void;
};

const getWorkspaceSSEUrl = (workspaceId: string) =>
  apiUrl(`/workspaces/${workspaceId}/events`);

/**
 * Subscribe to workspace-scoped SSE events and apply their validated React
 * Query cache actions.
 *
 * Auto-reconnects via the native EventSource reconnection
 * behaviour. Cleans up on unmount or when workspaceId changes.
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
              "useWorkspaceSSE",
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
        }
      }
    },
  );
  const captureClosedConnection = useLatestCallback(() => {
    analytics.captureError(
      new Error(`SSE connection closed for workspace ${workspaceId}`),
    );
  });

  useExternalSyncEffect(() => {
    const source = new EventSource(
      getWorkspaceSSEUrl(workspaceId),
      WORKSPACE_SSE_EVENT_SOURCE_INIT,
    );

    const handleMessage = (event: MessageEvent) => {
      const parsed = parseWorkspaceRealtimeMessage(String(event.data));
      if (!parsed) {
        return;
      }

      handleParsedEvent(parsed);
    };

    const handleError = () => {
      // EventSource auto-reconnects; capture for observability
      // only if the connection is fully closed.
      if (source.readyState === EventSource.CLOSED) {
        captureClosedConnection();
      }
    };

    source.addEventListener("message", handleMessage);
    source.addEventListener("error", handleError);

    return () => {
      source.removeEventListener("message", handleMessage);
      source.removeEventListener("error", handleError);
      source.close();
    };
  }, [workspaceId, captureClosedConnection, handleParsedEvent]);
};
