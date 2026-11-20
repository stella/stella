import type { QueryClient } from "@tanstack/react-query";

import type { WorkspaceView } from "@/lib/types";
import { CalendarViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view.pending";
import { CorrespondenceViewSkeleton } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-view.pending";
import { OverviewViewPending } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view.pending";
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
  // A board's columns come from its grouping, which the board resolves once
  // it mounts; it then stands with its columns and card placeholders. A
  // filesystem tree, a timeline and an AVT view claim no shape either.
  return null;
};
