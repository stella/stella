import { useEffect, useRef } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { env } from "@/env";
import { useAnalytics } from "@/lib/analytics/provider";

const INVALIDATE_QUERY_EVENT_TYPE = "invalidate-query";
const WORKSPACE_SSE_EVENT_SOURCE_INIT = {
  withCredentials: true,
} satisfies EventSourceInit;

type WorkspaceSSEEvent = {
  type: string;
  data: unknown;
};

type UseWorkspaceSSEOptions = {
  onEvent?: (event: WorkspaceSSEEvent) => void;
};

const getWorkspaceSSEUrl = (workspaceId: string) =>
  `${env.VITE_API_URL}/v1/workspaces/${workspaceId}/events`;

const parseWorkspaceSSEEvent = (data: string): WorkspaceSSEEvent | null => {
  const parsed: unknown = JSON.parse(data);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof parsed.type !== "string"
  ) {
    return null;
  }

  return {
    type: parsed.type,
    data: "data" in parsed ? parsed.data : undefined,
  };
};

/**
 * Subscribe to workspace-scoped SSE events. On receiving an
 * `invalidate-query` event, the corresponding React Query keys
 * are invalidated, triggering background refetches.
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

  // Use refs so the EventSource event handler always reads
  // the latest queryClient without re-creating the connection.
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  const analyticsRef = useRef(analytics);
  analyticsRef.current = analytics;

  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;

  useEffect(() => {
    const source = new EventSource(
      getWorkspaceSSEUrl(workspaceId),
      WORKSPACE_SSE_EVENT_SOURCE_INIT,
    );

    source.addEventListener("message", (event: MessageEvent) => {
      try {
        const parsed = parseWorkspaceSSEEvent(String(event.data));
        if (!parsed) {
          return;
        }

        onEventRef.current?.(parsed);

        if (
          parsed.type === INVALIDATE_QUERY_EVENT_TYPE &&
          Array.isArray(parsed.data)
        ) {
          // eslint-disable-next-line typescript/no-floating-promises
          queryClientRef.current.invalidateQueries({ queryKey: parsed.data });
        }
      } catch {
        // Malformed SSE data; ignore.
      }
    });

    source.addEventListener("error", () => {
      // EventSource auto-reconnects; capture for observability
      // only if the connection is fully closed.
      if (source.readyState === EventSource.CLOSED) {
        analyticsRef.current.captureError(
          new Error(`SSE connection closed for workspace ${workspaceId}`),
        );
      }
    });

    return () => {
      source.close();
    };
  }, [workspaceId]);
};
