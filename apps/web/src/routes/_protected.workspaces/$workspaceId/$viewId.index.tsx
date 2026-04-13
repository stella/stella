import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { CalendarView } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view";
import { FilesystemView } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view";
import { KanbanView } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view";
import { OverviewView } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view";
import { TableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-layout";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

const viewRoute = getRouteApi("/_protected/workspaces/$workspaceId/$viewId");

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { workspaceId, viewId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const page = viewRoute.useSearch({ select: (s) => s.page ?? 1 });
  const { data: activeView } = useSuspenseQuery({
    ...viewsOptions(workspaceId),
    select: (data) => data.find((v) => v.id === viewId) ?? data.at(0),
  });

  if (!activeView) {
    return null;
  }

  switch (activeView.layout.type) {
    case "table":
      return (
        <TableLayout
          page={page}
          view={{ ...activeView, layout: activeView.layout }}
          workspaceId={workspaceId}
        />
      );
    case "overview":
      return <OverviewView workspaceId={workspaceId} />;
    case "filesystem":
      return <FilesystemView view={activeView} workspaceId={workspaceId} />;
    case "kanban":
      return <KanbanView view={activeView} workspaceId={workspaceId} />;
    case "calendar":
      return (
        <CalendarView
          view={{ ...activeView, layout: activeView.layout }}
          workspaceId={workspaceId}
        />
      );
    case "timeline":
      return null;
    default: {
      return null;
    }
  }
}
