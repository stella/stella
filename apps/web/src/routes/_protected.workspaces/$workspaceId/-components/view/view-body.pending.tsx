import type { QueryClient } from "@tanstack/react-query";

import type { WorkspaceView } from "@/lib/types";
import { CalendarViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view.pending";
import { CorrespondenceViewSkeleton } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-view.pending";
import { FilesystemViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view.pending";
import { KanbanViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.pending";
import { OverviewViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view.pending";
import { cachedWorkspaceProperties } from "@/routes/_protected.workspaces/$workspaceId/-components/table/pending-table-columns.logic";
import { TableViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-layout.pending";

type ViewBodyPendingProps = {
  /** The app's cache, or `null` where nothing can be read yet. */
  cache: QueryClient | null;
  /** The view the URL names, as the cache holds it; unknown until then. */
  view: WorkspaceView | undefined;
  workspaceId: string | undefined;
};

/**
 * A matter view's body before its data: the pending body of the layout the
 * cached view has, at the place and in the shape the layout will draw. A
 * view the cache does not hold yet has no shape to claim, so its body stays
 * empty rather than guessing a layout that would change under the reader;
 * the same goes for the layouts that have no pending body of their own yet.
 */
export const ViewBodyPending = ({
  cache,
  view,
  workspaceId,
}: ViewBodyPendingProps) => {
  if (view === undefined || workspaceId === undefined) {
    return null;
  }
  const { layout } = view;
  if (layout.type === "table") {
    return (
      <TableViewPending
        cache={cache}
        view={{ ...view, layout }}
        workspaceId={workspaceId}
      />
    );
  }
  if (layout.type === "overview") {
    return <OverviewViewPending />;
  }
  if (layout.type === "calendar") {
    return <CalendarViewPending view={{ ...view, layout }} />;
  }
  if (layout.type === "correspondence") {
    return <CorrespondenceViewSkeleton />;
  }
  if (layout.type === "kanban" || layout.type === "filesystem") {
    // A board's columns and a tree's columns come from the matter's
    // properties; without them neither has columns to claim.
    const properties =
      cache === null
        ? undefined
        : cachedWorkspaceProperties(cache, workspaceId);
    if (properties === undefined) {
      return null;
    }
    if (layout.type === "kanban") {
      return <KanbanViewPending properties={properties} view={view} />;
    }
    return (
      <FilesystemViewPending
        properties={properties}
        view={{ ...view, layout }}
        workspaceId={workspaceId}
      />
    );
  }
  // A timeline view draws no body at all, and an AVT view first checks the
  // caller may open it (it may redirect away): neither has a shape to claim.
  return null;
};
