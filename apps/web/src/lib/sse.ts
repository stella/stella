import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { WorkspaceRealtimeEvent } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";
import { stellaToast } from "@stll/ui/toast";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { detached } from "@/lib/detached";
import {
  getWorkspaceRealtimeQueryActions,
  isWorkspaceQueryKey,
  parseWorkspaceRealtimeMessage,
  WORKSPACE_REALTIME_QUERY_ACTION,
} from "@/lib/workspace-realtime";
import {
  connectWorkspaceStream,
  WORKSPACE_STREAM_ACCESS,
  workspaceStreamAccessFromStatus,
} from "@/lib/workspace-sse-connection.logic";
import type { WorkspaceStreamAccess } from "@/lib/workspace-sse-connection.logic";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";

const WORKSPACE_SSE_EVENT_SOURCE_INIT = {
  withCredentials: true,
} satisfies EventSourceInit;

// Long enough for the stream's access check, short enough that a hung probe
// only delays the next reconnect attempt.
const WORKSPACE_STREAM_PROBE_TIMEOUT_MS = 10_000;

type UseWorkspaceSSEOptions = {
  onEvent?: (event: WorkspaceRealtimeEvent) => void;
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
  options: UseWorkspaceSSEOptions = {},
) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const t = useTranslations();

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
  const leaveEndedMatter = useLatestCallback(async () => {
    stellaToast.add({ title: t("errors.matterNotFound"), type: "error" });
    // Leave first: dropping the cache while the matter's views are still
    // mounted would only make them refetch into the same refusal.
    await navigate({ to: "/workspaces", replace: true });
    queryClient.removeQueries({
      predicate: (query) => isWorkspaceQueryKey(query.queryKey, workspaceId),
    });
    await queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
  });

  useExternalSyncEffect(
    () =>
      connectWorkspaceStream({
        openSource: ({ onOpen, onMessage, onError }) => {
          const stream = new EventSource(
            getWorkspaceSSEUrl(workspaceId),
            WORKSPACE_SSE_EVENT_SOURCE_INIT,
          );
          stream.addEventListener("open", onOpen);
          stream.addEventListener("message", (event: MessageEvent) => {
            onMessage(String(event.data));
          });
          stream.addEventListener("error", onError);
          return {
            isClosed: () => stream.readyState === EventSource.CLOSED,
            close: () => {
              stream.close();
            },
          };
        },
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
          const parsed = parseWorkspaceRealtimeMessage(data);
          if (parsed) {
            handleParsedEvent(parsed);
          }
        },
        onOutage: captureConnectionOutage,
        onAccessEnded: () => {
          detached(leaveEndedMatter(), "workspace-stream.leave-ended-matter");
        },
      }),
    [workspaceId, captureConnectionOutage, handleParsedEvent, leaveEndedMatter],
  );
};
