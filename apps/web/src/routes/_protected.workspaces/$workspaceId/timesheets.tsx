import { createFileRoute } from "@tanstack/react-router";

import { redirectToDefaultWorkspaceView } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  // Time tracking is intentionally excluded from the current product surface.
  // Keep this route redirect-only so abandoned /timesheets navigations cannot
  // mount the old billing query tree before the redirect commits.
  beforeLoad: async ({ context, params }) => {
    await redirectToDefaultWorkspaceView({
      queryClient: context.queryClient,
      workspaceId: params.workspaceId,
    });
  },
});
