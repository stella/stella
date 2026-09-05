import { useState } from "react";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";

import {
  REALTIME_EVENT_TYPE,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";
import { stellaToast } from "@stll/ui/toast";

import { WorkflowServiceTierPromptProvider } from "@/components/workspaces/workflow-service-tier-prompt";
import { WorkflowStartConfirmationPromptProvider } from "@/components/workspaces/workflow-start-confirmation-prompt";
import { useWorkspaceChatMentionRegistration } from "@/features/chat/hooks/use-workspace-chat-mention-registration";
import { useMountEffect } from "@/hooks/use-effect";
import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { pageTitle, pageTitleLiteral } from "@/lib/page-title";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { useWorkspaceSSE } from "@/lib/sse";
import { overviewOptions, workspaceOptions } from "@/lib/workspaces/queries";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { workflowOptions } from "@/lib/workspaces/queries/workspace";
import { useWorkspaceStore } from "@/lib/workspaces/store";
import { ReportExportTracker } from "@/routes/_protected.workspaces/$workspaceId/-components/view/report-export-tracker";
import { WorkspaceDropZone } from "@/routes/_protected.workspaces/$workspaceId/-components/workspace-drop-zone";
import { loadWorkspaceRouteQueries } from "@/routes/_protected.workspaces/$workspaceId/-route-loader.logic";

const EXTRACTION_PREVIEW_CLIENT_TTL_MS = 5 * 60 * 1000;
const ACTIVITY_INVALIDATION_DEBOUNCE_MS = 1000;
const ACTIVITY_INVALIDATION_MAX_WAIT_MS = 5000;

const extractionPreviewKey = (entityId: string, propertyId: string) =>
  `${entityId}:${propertyId}`;

export const Route = createFileRoute("/_protected/workspaces/$workspaceId")({
  component: RouteComponent,
  notFoundComponent: () => {
    // Handles unmatched child routes (e.g. doubled
    // /workspaces/$id/workspaces/$id from stale router state).
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- dev-only stack trace to debug stale doubled URLs
      console.trace(
        "[stella] notFoundComponent triggered — redirecting to /workspaces. Current URL:",
        globalThis.location.href,
      );
    }
    return <Navigate replace to="/workspaces" />;
  },
  loader: async ({ context, params }) => {
    const wsId = params.workspaceId;
    const qc = context.queryClient;

    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };

    // Only the workspace name blocks the breadcrumb. Start every independent
    // metadata request before awaiting it so they share the first network round.
    return await loadWorkspaceRouteQueries({
      loadWorkspace: async () => await loadWorkspaceOrRedirect(qc, wsId),
      startPrefetches: [
        () =>
          detached(
            prefetchRouteQuery(
              qc,
              workflowOptions({ key: { workspaceId: wsId } }),
              onPrefetchError,
            ),
            "workspaces.prefetch",
          ),
        () =>
          detached(
            prefetchRouteQuery(qc, viewsOptions(wsId), onPrefetchError),
            "workspaces.prefetch",
          ),
        () =>
          detached(
            prefetchRouteQuery(qc, overviewOptions(wsId), onPrefetchError),
            "workspaces.prefetch",
          ),
        () =>
          detached(
            prefetchRouteQuery(qc, propertiesOptions(wsId), onPrefetchError),
            "workspaces.prefetch",
          ),
      ],
    });
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.name
          ? pageTitleLiteral(loaderData.name)
          : pageTitle("common.matters"),
      },
    ],
  }),
});

const loadWorkspaceOrRedirect = async (
  queryClient: QueryClient,
  workspaceId: string,
) => {
  try {
    return await ensureRouteQueryData(
      queryClient,
      workspaceOptions(workspaceId),
    );
  } catch (error) {
    if (APIError.is(error) && error.status === 404) {
      // The redirect swallows this branch, so capture here; the rethrow
      // below reaches the route error boundary, which captures already.
      getAnalytics().captureError(error);
      const t = getTranslator();
      stellaToast.add({
        title: t("errors.matterNotFound"),
        type: "error",
      });
      throw redirect({ to: "/workspaces", replace: true });
    }

    throw error;
  }
};

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });
  const queryClient = useQueryClient();
  // Lazy state singleton (mutated in place, identity stable): avoids both
  // the render-scope ref write (React Compiler bailout) and per-render
  // allocation.
  const [previewClearTimers] = useState(
    () => new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const invalidateActivity = useDebouncedCallback(
    (workspaceIdToInvalidate: string) => {
      detached(
        queryClient.invalidateQueries({
          queryKey: workspacesKeys.overviewActivityAll(workspaceIdToInvalidate),
        }),
        "workspaces.invalidate",
      );
    },
    ACTIVITY_INVALIDATION_DEBOUNCE_MS,
    { maxWait: ACTIVITY_INVALIDATION_MAX_WAIT_MS },
  );

  const handleWorkspaceSSEEvent = (event: WorkspaceRealtimeEvent) => {
    switch (event.type) {
      case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
      case REALTIME_EVENT_TYPE.RESOURCE_DELETED:
      case REALTIME_EVENT_TYPE.RESOURCES_CHANGED:
      case REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED:
        invalidateActivity(workspaceId);
        return;
      case REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE:
        return;
      case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
        break;
      default:
        event satisfies never;
        return;
    }

    const data = event.data;
    const workspaceStore = useWorkspaceStore.getState();

    // Backend sends "clear" right after the entity-invalidation
    // broadcast, but the invalidation's refetch needs a network
    // round-trip — clearing the preview synchronously here makes
    // the cell flip preview → pending skeleton → final value, with
    // the skeleton visible for the duration of the refetch. Hold
    // the preview instead: EditableField only reads it while the
    // field is still pending, so once the refetch lands and the
    // field finalises, the preview becomes invisible automatically.
    // The TTL below still cleans up if the stream is abandoned.
    if (data.status === "clear" || data.answer === null) {
      return;
    }

    const timers = previewClearTimers;
    const key = extractionPreviewKey(data.entityId, data.propertyId);
    const previousTimer = timers.get(key);
    if (previousTimer !== undefined) {
      clearTimeout(previousTimer);
    }

    workspaceStore.setExtractionPreview({
      entityId: data.entityId,
      propertyId: data.propertyId,
      answer: data.answer,
    });

    const nextTimer = setTimeout(() => {
      useWorkspaceStore
        .getState()
        .clearExtractionPreview(data.entityId, data.propertyId);
      timers.delete(key);
    }, EXTRACTION_PREVIEW_CLIENT_TTL_MS);
    timers.set(key, nextTimer);
  };

  // Subscribe to workspace SSE events for real-time query invalidation.
  useWorkspaceSSE(workspaceId, { onEvent: handleWorkspaceSSEEvent });

  // Register the matter's entities as `@`-mention sources for any
  // chat editor mounted inside this workspace (right-panel chat,
  // inspector chat tab, file-overlay chat). Picks the first view
  // automatically — entity mentions don't depend on the current
  // view, but the underlying query needs one to scope the fetch.
  useWorkspaceChatMentionRegistration(workspaceId);

  const timesheetsMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/timesheets",
    shouldThrow: false,
  });
  const invoicesMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/invoices",
    shouldThrow: false,
  });
  // The right-side inspector pane (file viewers + chat tabs) is
  // mounted at the protected layout level (`_protected.tsx`) so
  // its mount survives matter→matter switches without flinching.
  // Timesheets and invoices bypass the
  // WorkspaceDropZone (they have their own layouts), but the inspector
  // pane is still available everywhere inside a workspace.
  const content =
    timesheetsMatch || invoicesMatch ? (
      <Outlet />
    ) : (
      <WorkspaceDropZone workspaceId={workspaceId}>
        <Outlet />
      </WorkspaceDropZone>
    );

  return (
    <WorkflowStartConfirmationPromptProvider>
      <WorkspaceLifecycleCleanup
        flushActivityInvalidation={invalidateActivity.flush}
        key={workspaceId}
        previewClearTimers={previewClearTimers}
      />
      <ReportExportTracker workspaceId={workspaceId} />
      <WorkflowServiceTierPromptProvider>
        {content}
      </WorkflowServiceTierPromptProvider>
    </WorkflowStartConfirmationPromptProvider>
  );
}

const WorkspaceLifecycleCleanup = ({
  flushActivityInvalidation,
  previewClearTimers,
}: {
  flushActivityInvalidation: () => void;
  previewClearTimers: Map<string, ReturnType<typeof setTimeout>>;
}) => {
  useMountEffect(() => () => {
    flushActivityInvalidation();
    for (const timer of previewClearTimers.values()) {
      clearTimeout(timer);
    }
    previewClearTimers.clear();

    const workspaceStore = useWorkspaceStore.getState();
    workspaceStore.clearJustifications();
    workspaceStore.clearExtractionPreviews();
    workspaceStore.setActiveJustification(null);
    workspaceStore.resetPdfViewerState();
  });
  return null;
};
