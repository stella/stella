import { useEffect } from "react";

import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import { Group, Panel, Separator } from "react-resizable-panels";

import { toastManager } from "@stella/ui/components/toast";

import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { APIError } from "@/lib/errors";
import { pageTitle, pageTitleLiteral } from "@/lib/page-title";
import {
  ensureCriticalQueryData,
  prefetchNonCriticalQuery,
} from "@/lib/react-query";
import { useWorkspaceSSE } from "@/lib/sse";
import { DropZone } from "@/routes/_protected.workspaces/$workspaceId/-components/drop-zone";
import { InspectorPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-panel";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workflowOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  overviewOptions,
  workspaceOptions,
} from "@/routes/_protected.workspaces/-queries";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId")({
  component: RouteComponent,
  notFoundComponent: () => {
    // Handles unmatched child routes (e.g. doubled
    // /workspaces/$id/workspaces/$id from stale router state).
    throw redirect({ to: "/workspaces" });
  },
  onError: (error) => {
    if (error instanceof APIError && error.status === 404) {
      const t = getTranslator();
      toastManager.add({
        title: t("errors.matterNotFound"),
        type: "error",
      });
      throw redirect({ to: "/workspaces" });
    }
  },
  loader: async ({ context, params, cause }) => {
    const wsId = params.workspaceId;
    const qc = context.queryClient;

    void prefetchNonCriticalQuery(
      qc,
      workflowOptions({ key: { workspaceId: wsId } }),
      (error: unknown) => {
        getAnalytics().captureError(error);
      },
    );

    // Only block on workspace name (breadcrumb). Everything else
    // is prefetched — components use useSuspenseQuery which resolves
    // from cache or shows granular loading states.
    const [workspace] = await Promise.all([
      ensureCriticalQueryData(qc, workspaceOptions(wsId)),
      cause === "enter"
        ? api.workspaces({ workspaceId: wsId }).active.post()
        : Promise.resolve(),
    ]);

    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };
    void prefetchNonCriticalQuery(qc, viewsOptions(wsId), onPrefetchError);
    void prefetchNonCriticalQuery(qc, overviewOptions(wsId), onPrefetchError);
    void prefetchNonCriticalQuery(qc, propertiesOptions(wsId), onPrefetchError);

    return workspace;
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

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });

  const authToken = Route.useRouteContext({
    select: (ctx) => ctx.authToken,
  });

  // Subscribe to workspace SSE events for real-time query
  // invalidation (replaces the Rivet sync actor for this workspace).
  useWorkspaceSSE(workspaceId, authToken);

  // Clean up inspector tabs when the workspace changes so
  // stale IDs from the previous workspace don't cause
  // broken previews.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      useInspectorStore.getState().closeAll();
      const workspaceStore = useWorkspaceStore.getState();
      workspaceStore.clearJustifications();
      workspaceStore.setActiveJustification(null);
      workspaceStore.resetPdfViewerState();
    },
    [workspaceId],
  );

  const timesheetsMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/timesheets",
    shouldThrow: false,
  });
  const analyticsMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/analytics",
    shouldThrow: false,
  });
  const invoicesMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/invoices",
    shouldThrow: false,
  });

  const hasSidePanel = useInspectorStore((s) => s.tabs.length > 0);

  // Timesheets, analytics, and invoices have their own layout
  if (timesheetsMatch || analyticsMatch || invoicesMatch) {
    return <Outlet />;
  }

  return (
    <DropZone workspaceId={workspaceId}>
      <Group orientation="horizontal">
        <Panel className="flex min-w-0 flex-col">
          <Outlet />
        </Panel>
        {hasSidePanel && (
          <>
            <Separator className="group data-[separator=active]:bg-border data-[separator=hover]:bg-border flex w-1 shrink-0 cursor-col-resize items-center justify-center">
              <div className="bg-border h-8 w-0.5 rounded-full group-data-[separator=active]:hidden group-data-[separator=hover]:hidden" />
            </Separator>
            <Panel defaultSize="32rem" maxSize="50rem" minSize="20rem">
              <InspectorPanel workspaceId={workspaceId} />
            </Panel>
          </>
        )}
      </Group>
    </DropZone>
  );
}
