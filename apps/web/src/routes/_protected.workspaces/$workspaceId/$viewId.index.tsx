import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ensureRouteQueryData } from "@/lib/react-query";
import type { ViewLayout, ViewLayoutType, WorkspaceView } from "@/lib/types";
import { CalendarView } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view";
import { FilesystemView } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view";
import { KanbanView } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view";
import { OverviewView } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view";
import { TableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-layout";
import {
  filesystemEntitiesOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { overviewOptions } from "@/routes/_protected.workspaces/-queries";

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
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const { workspaceId, viewId } = params;

    const views = await ensureRouteQueryData(
      queryClient,
      viewsOptions(workspaceId),
    );
    const activeView = views.find((view) => view.id === viewId) ?? views.at(0);

    if (!activeView) {
      return;
    }

    // FilesystemView, KanbanView, OverviewView, and TableLayout each suspend
    // on their own query below, but the switch in RouteComponent renders
    // exactly one of them, chosen by the server-returned view type. This map
    // references every one of those factories — so require-loader-prefetch's
    // colocated-import check (which sees all four suspense calls but not
    // which one actually renders) is satisfied — while only invoking the
    // branch matching activeView.layout.type, so a cold navigation warms
    // exactly the query the rendered view needs.
    const prefetchByViewType: Record<ViewLayoutType, () => Promise<void>> = {
      table: async () => {
        await ensureRouteQueryData(queryClient, propertiesOptions(workspaceId));
      },
      kanban: async () => {
        await ensureRouteQueryData(queryClient, propertiesOptions(workspaceId));
      },
      overview: async () => {
        await ensureRouteQueryData(queryClient, overviewOptions(workspaceId));
      },
      filesystem: async () => {
        if (!isFilesystemView(activeView)) {
          return;
        }
        const properties = await ensureRouteQueryData(
          queryClient,
          propertiesOptions(workspaceId),
        );
        const fieldIds = visibleEntityFieldIds({
          hiddenProperties: activeView.layout.hiddenProperties,
          properties,
        });
        await ensureRouteQueryData(
          queryClient,
          filesystemEntitiesOptions({
            workspaceId,
            filters: activeView.layout.filters,
            sorts: activeView.layout.sorts,
            fieldMode: "visible",
            fieldIds,
          }),
        );
      },
      calendar: async () => {
        // CalendarView has no suspense query of its own.
      },
      timeline: async () => {
        // Not yet implemented — RouteComponent renders null.
      },
    };

    await prefetchByViewType[activeView.layout.type]();
  },
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
