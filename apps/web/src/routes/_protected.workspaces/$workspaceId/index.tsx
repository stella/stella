import { createFileRoute } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";
import { routePresentation } from "@/routes/-route-presentation";
import { useDefaultWorkspaceViewRedirect } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

// While it resolves the matter's first view it shows that view's pending view.
export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  // Remount on workspace change so the mount-only redirect re-resolves and the
  // previous workspace's in-flight run is cancelled (no default remountDeps
  // otherwise keeps this component mounted across $workspaceId changes).
  remountDeps: ({ params }) => params.workspaceId,
  component: redirectRouteComponent({
    navigator: WorkspaceIndexNavigator,
    to: "/workspaces/$workspaceId/$viewId",
  }),
});

function WorkspaceIndexNavigator() {
  const queryClient = Route.useRouteContext({
    select: (context) => context.queryClient,
  });
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  useDefaultWorkspaceViewRedirect({ queryClient, workspaceId });

  return null;
}
