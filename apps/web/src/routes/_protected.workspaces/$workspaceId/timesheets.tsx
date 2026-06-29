import { createFileRoute } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { useDefaultWorkspaceViewRedirect } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  // Time tracking is intentionally excluded from the current product surface.
  // The route only redirects to the workspace's default view, from a mounted
  // component so no dormant product UI mounts on a direct/deep-link visit.
  component: TimesheetsRedirect,
});

function TimesheetsRedirect() {
  const queryClient = Route.useRouteContext({
    select: (context) => context.queryClient,
  });
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  useDefaultWorkspaceViewRedirect({ queryClient, workspaceId });

  return <DefaultPendingComponent />;
}
