import { createFileRoute } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { useDefaultWorkspaceViewRedirect } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  // Remount on workspace change so the mount-only redirect re-resolves and the
  // previous workspace's in-flight run is cancelled (no default remountDeps
  // otherwise keeps this component mounted across $workspaceId changes).
  remountDeps: ({ params }) => params.workspaceId,
  component: WorkspaceIndexRedirect,
});

function WorkspaceIndexRedirect() {
  const queryClient = Route.useRouteContext({
    select: (context) => context.queryClient,
  });
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  useDefaultWorkspaceViewRedirect({ queryClient, workspaceId });

  return <DefaultPendingComponent />;
}
