import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  // Time tracking is intentionally excluded from the current product surface.
  // Keep this route redirect-only so abandoned /timesheets navigations cannot
  // mount the old billing query tree before the redirect commits.
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/workspaces/$workspaceId",
      params: {
        workspaceId: params.workspaceId,
      },
      replace: true,
    });
  },
});
