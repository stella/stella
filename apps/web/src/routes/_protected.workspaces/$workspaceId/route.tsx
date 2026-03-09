import { useEffect } from "react";
import { createFileRoute, Outlet, useMatch } from "@tanstack/react-router";
import { Group, Panel, Separator } from "react-resizable-panels";

import { api } from "@/lib/api";
import { pageTitle, pageTitleLiteral } from "@/lib/page-title";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";
import { DropZone } from "@/routes/_protected.workspaces/$workspaceId/-components/drop-zone";
import { PeekPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-panel";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { useSyncTable } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-table";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId")({
  component: RouteComponent,
  beforeLoad: ({ params }) => {
    const wsId = params.workspaceId;

    // Fire-and-forget: track last active workspace for
    // redirect-on-load.
    api
      .workspaces({ workspaceId: wsId })
      ["last-active"].post()
      .catch(() => undefined);
  },
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(workspaceOptions(params.workspaceId)),
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

  // Clean up peek tabs when the workspace changes so stale
  // field IDs from the previous workspace don't cause broken
  // PDF previews.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId triggers cleanup on navigation
  useEffect(() => {
    return () => usePeekStore.getState().closeAll();
  }, [workspaceId]);

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

  const hasPeekTabs = usePeekStore((s) => s.tabs.length > 0);

  // Timesheets, analytics, and invoices have their own layout
  if (timesheetsMatch || analyticsMatch || invoicesMatch) {
    return <Outlet />;
  }

  return (
    <DropZone workspaceId={workspaceId}>
      <Group orientation="horizontal">
        <Panel className="flex flex-col">
          <Outlet />
        </Panel>
        {hasPeekTabs && (
          <>
            <Separator className="group flex w-1 shrink-0 cursor-col-resize items-center justify-center data-[separator=active]:bg-border data-[separator=hover]:bg-border">
              <div className="h-8 w-0.5 rounded-full bg-border group-data-[separator=active]:hidden group-data-[separator=hover]:hidden" />
            </Separator>
            <Panel defaultSize="32rem" maxSize="50rem" minSize="20rem">
              <PeekPanel workspaceId={workspaceId} />
            </Panel>
          </>
        )}
      </Group>
    </DropZone>
  );
}
