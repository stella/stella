import { Suspense } from "react";
import type { ReactNode } from "react";

import { usePendingCache } from "@/components/pending-cache";
import type { WorkspaceView } from "@/lib/types";
import { framePendingView } from "@/routes/-pending-view.logic";
import { ViewBodyPending } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-body.pending";

import { ViewPending } from "./-$viewId.route.pending";

/**
 * The view's body with its layout's pending body as its fallback. A layout
 * reads more than the route's loaders prime before it can draw (a grouped
 * table's sections, a board's columns, the AVT view's chunk); while it
 * suspends, the tabs row and the toolbar stay and only the body waits, in
 * the shape it will take. Priming those reads in the loader instead would
 * chain them (properties, then the group counts, then each section's page)
 * before the route could render anything at all.
 */
export const ViewBodyBoundary = ({
  children,
  view,
  workspaceId,
}: {
  children: ReactNode;
  view: WorkspaceView;
  workspaceId: string;
}) => {
  const cache = usePendingCache();
  return (
    <Suspense
      fallback={
        <ViewBodyPending cache={cache} view={view} workspaceId={workspaceId} />
      }
    >
      {children}
    </Suspense>
  );
};

/**
 * The view's body route in its pending phase. It is the leaf of every view
 * URL, so the cold-load frame draws it as the whole page: the view's own
 * pending view, which draws its tabs row too unless the loaded row already
 * stands above it.
 */
const ViewIndexPendingView = () => <ViewPending />;

export const ViewIndexPending = framePendingView(ViewIndexPendingView);
