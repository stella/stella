import { useRef } from "react";
import type { ReactNode } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Outlet, useMatches } from "@tanstack/react-router";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { detached } from "@/lib/detached";
import type { WorkspaceView } from "@/lib/types";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { selectAvailableWorkspaceView } from "@/lib/workspaces/queries/views.logic";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";
import { hasViewToolbar } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-chrome.logic";
import { ViewSwitcher } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher";
import { ViewToolbar } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar";

import { ViewChromeRowFace } from "./-$viewId.route.pending";

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/$viewId");

/** The matter view: its tabs row and toolbar over the view the URL names. */
export function ViewPage() {
  const { workspaceId, viewId } = routeApi.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const viewsQueryOptions = viewsOptions(workspaceId);
  const { data: activeView } = useSuspenseQuery({
    ...viewsQueryOptions,
    select: (data) => selectAvailableWorkspaceView(data, viewId),
  });

  if (!activeView) {
    return null;
  }

  if (activeView.layout.type === "overview") {
    return (
      <OverviewViewContent activeView={activeView} workspaceId={workspaceId} />
    );
  }

  return (
    <EntityViewContent activeView={activeView} workspaceId={workspaceId} />
  );
}

type ViewContentProps = {
  activeView: WorkspaceView;
  workspaceId: string;
};

type VisibleFieldsView = WorkspaceView & {
  layout: Extract<WorkspaceView["layout"], { type: "filesystem" }>;
};

function OverviewViewContent({ activeView, workspaceId }: ViewContentProps) {
  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

function EntityViewContent({ activeView, workspaceId }: ViewContentProps) {
  if (hasVisibleFieldsLayout(activeView)) {
    return (
      <VisibleFieldEntityViewContent
        activeView={activeView}
        workspaceId={workspaceId}
      />
    );
  }

  if (activeView.layout.type === "table") {
    return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
  }

  if (activeView.layout.type === "calendar") {
    return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
  }

  if (activeView.layout.type === "kanban") {
    return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
  }

  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

const hasVisibleFieldsLayout = (
  view: WorkspaceView,
): view is VisibleFieldsView => view.layout.type === "filesystem";

function VisibleFieldEntityViewContent({
  activeView,
  workspaceId,
}: ViewContentProps & { activeView: VisibleFieldsView }) {
  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

function ViewShell({ activeView, workspaceId }: ViewContentProps) {
  const matches = useMatches();
  const isOnPdfRoute = getCurrentWorkspaceDocument(matches) !== undefined;
  const paneRef = useRef<HTMLDivElement>(null);

  // File detail view: hide the view chrome; breadcrumbs provide navigation
  // back to the matter.
  if (isOnPdfRoute) {
    return <Outlet />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={paneRef}>
      <ViewChromeRow
        activeViewId={activeView.id}
        toolbar={
          hasViewToolbar(activeView) ? (
            <ViewToolbar
              paneRef={paneRef}
              view={activeView}
              workspaceId={workspaceId}
            />
          ) : null
        }
        workspaceId={workspaceId}
      />
      <div
        className="flex min-h-0 flex-1 flex-col"
        {...guideAnchor(
          GUIDE_ANCHORS.tabularReviewTable,
          activeView.layout.type === "table",
        )}
      >
        <div
          className="flex-1 overflow-auto"
          {...guideAnchor(
            GUIDE_ANCHORS.documentsList,
            activeView.layout.type === "table",
          )}
        >
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/** The view tabs row with the switcher's behaviour. */
function ViewChromeRow({
  activeViewId,
  toolbar,
  workspaceId,
}: {
  activeViewId: string;
  toolbar: ReactNode;
  workspaceId: string;
}) {
  const navigate = routeApi.useNavigate();
  return (
    <ViewChromeRowFace
      switcher={
        <ViewSwitcher
          activeViewId={activeViewId}
          onViewChange={(viewId) => {
            detached(
              navigate({
                to: "/workspaces/$workspaceId/$viewId",
                params: { workspaceId, viewId },
                search: { page: undefined },
              }),
              "workspace-view.navigate",
            );
          }}
          workspaceId={workspaceId}
        />
      }
      toolbar={toolbar}
    />
  );
}
