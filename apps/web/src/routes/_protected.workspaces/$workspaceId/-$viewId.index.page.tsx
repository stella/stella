import { lazy } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { panic } from "better-result";

import { detached } from "@/lib/detached";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { selectAvailableWorkspaceView } from "@/lib/workspaces/queries/views.logic";
import {
  isAvtView,
  isCalendarView,
  isFilesystemView,
  isTableView,
} from "@/lib/workspaces/view-layout";
import { CalendarView } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view";
import { CorrespondenceView } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-view";
import { FilesystemView } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view";
import { KanbanView } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view";
import { OverviewView } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view";
import { TableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-layout";

import { ViewBodyBoundary } from "./-$viewId.index.pending";

// The AVT view loads only after caller feature admission.
const AvtRoute = lazy(async () => {
  const m = await import("@/features/avt/avt-route");
  return { default: m.AvtRoute };
});

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/$viewId/");

/** The matter view's body: the layout of the view the URL names. */
export function ViewIndexPage() {
  const { workspaceId, viewId } = routeApi.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const { data: activeView } = useSuspenseQuery({
    ...viewsOptions(workspaceId),
    select: (data) => selectAvailableWorkspaceView(data, viewId),
  });

  if (!activeView) {
    return null;
  }

  return (
    <ViewBodyBoundary view={activeView} workspaceId={workspaceId}>
      <ViewLayoutBody view={activeView} workspaceId={workspaceId} />
    </ViewBodyBoundary>
  );
}

const ViewLayoutBody = ({
  view,
  workspaceId,
}: {
  view: NonNullable<ReturnType<typeof selectAvailableWorkspaceView>>;
  workspaceId: string;
}) => {
  const runId = routeApi.useSearch({ select: (search) => search.run });
  const mode = routeApi.useSearch({ select: (search) => search.mode });
  const navigate = routeApi.useNavigate();

  switch (view.layout.type) {
    case "table":
      if (!isTableView(view)) {
        return null;
      }
      return <TableLayout view={view} workspaceId={workspaceId} />;
    case "overview":
      return <OverviewView workspaceId={workspaceId} />;
    case "filesystem":
      if (!isFilesystemView(view)) {
        return null;
      }
      return <FilesystemView view={view} workspaceId={workspaceId} />;
    case "kanban":
      return <KanbanView view={view} workspaceId={workspaceId} />;
    case "calendar":
      if (!isCalendarView(view)) {
        return null;
      }
      return <CalendarView view={view} workspaceId={workspaceId} />;
    case "timeline":
      return null;
    case "avt":
      if (!isAvtView(view)) {
        return null;
      }
      return (
        <AvtRoute
          mode={mode}
          onModeChange={(next) => {
            detached(navigate({ search: { mode: next } }), "avt-view.mode");
          }}
          onRunChange={(run) => {
            detached(navigate({ search: { run } }), "avt-view.open-run");
          }}
          runId={runId}
          view={view}
          workspaceId={workspaceId}
        />
      );
    case "correspondence":
      return <CorrespondenceView workspaceId={workspaceId} />;
    default: {
      view.layout satisfies never;
      return panic(`Unhandled view layout: ${String(view.layout)}`);
    }
  }
};
