import { useEffect } from "react";

import { createFileRoute, Outlet, useMatch } from "@tanstack/react-router";
import { Group, Panel, Separator } from "react-resizable-panels";

import { api } from "@/lib/api";
import { pageTitle, pageTitleLiteral } from "@/lib/page-title";
import { DropZone } from "@/routes/_protected.workspaces/$workspaceId/-components/drop-zone";
import { InspectorPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-panel";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useSyncTable } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-table";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId")({
  component: RouteComponent,
  beforeLoad: ({ params }) => {
    const wsId = params.workspaceId;

    // Fire-and-forget: track last active workspace for
    // redirect-on-load.
    api
      .workspaces({ workspaceId: wsId })
      ["last-active"].post()
      // oxlint-disable-next-line no-empty-function
      .catch(() => {});
  },
  loader: async ({ context, params }) =>
    await context.queryClient.ensureQueryData(
      workspaceOptions(params.workspaceId),
    ),
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
  useSyncTable();

  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });

  // Clean up inspector tabs when the workspace changes so
  // stale IDs from the previous workspace don't cause
  // broken previews.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      useInspectorStore.getState().closeAll();
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
