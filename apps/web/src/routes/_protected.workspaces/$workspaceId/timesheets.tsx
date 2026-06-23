import { createFileRoute } from "@tanstack/react-router";

import { redirectToDefaultWorkspaceView } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  // Time tracking is intentionally excluded from the current product surface.
  // Keep the disabled route redirect-only so dormant UI cannot mount during
  // direct URL or deep-link navigation.
  beforeLoad: async ({ context, params }) => {
    await redirectToDefaultWorkspaceView({
      queryClient: context.queryClient,
      workspaceId: params.workspaceId,
    });
  },
});
