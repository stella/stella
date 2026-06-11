import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import type { ViewLayout, WorkspaceView } from "@/lib/types";
import { CalendarView } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view";
import { FilesystemView } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view";
import { KanbanView } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view";
import { OverviewView } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view";
import { TableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-layout";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

type TableWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "table" }>;
};

type FilesystemWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "filesystem" }>;
};

type CalendarWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "calendar" }>;
};

const isTableView = (view: WorkspaceView): view is TableWorkspaceView =>
  view.layout.type === "table";

const isFilesystemView = (
  view: WorkspaceView,
): view is FilesystemWorkspaceView => view.layout.type === "filesystem";

const isCalendarView = (view: WorkspaceView): view is CalendarWorkspaceView =>
  view.layout.type === "calendar";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { workspaceId, viewId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const { data: activeView } = useSuspenseQuery({
    ...viewsOptions(workspaceId),
    select: (data) => data.find((v) => v.id === viewId) ?? data.at(0),
  });

  if (!activeView) {
    return null;
  }

  switch (activeView.layout.type) {
    case "table":
      if (!isTableView(activeView)) {
        return null;
      }
      return <TableLayout view={activeView} workspaceId={workspaceId} />;
    case "overview":
      return <OverviewView workspaceId={workspaceId} />;
    case "filesystem":
      if (!isFilesystemView(activeView)) {
        return null;
      }
      return <FilesystemView view={activeView} workspaceId={workspaceId} />;
    case "kanban":
      return <KanbanView view={activeView} workspaceId={workspaceId} />;
    case "calendar":
      if (!isCalendarView(activeView)) {
        return null;
      }
      return <CalendarView view={activeView} workspaceId={workspaceId} />;
    case "timeline":
      return null;
    default: {
      return null;
    }
  }
}
