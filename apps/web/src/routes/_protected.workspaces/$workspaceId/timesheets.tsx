import { createFileRoute, redirect } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { useDefaultWorkspaceViewRedirect } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  // Gated behind FEATURE_TIME_BILLING. While the flag is off the route is not
  // part of the product surface, so redirect to the workspace's default view
  // from beforeLoad. With the flag on it falls through to a mounted component
  // that redirects the same way, so no dormant product UI mounts on a
  // direct/deep-link visit. Remount on workspace change so a stale in-flight
  // redirect is cancelled.
  beforeLoad: ({ params }) => {
    if (!isTimeBillingRouteEnabled()) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  remountDeps: ({ params }) => params.workspaceId,
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
