import { createFileRoute } from "@tanstack/react-router";

import { redirectToDefaultWorkspaceView } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  beforeLoad: async ({ context, params }) => {
    await redirectToDefaultWorkspaceView({
      queryClient: context.queryClient,
      workspaceId: params.workspaceId,
    });
  },
});
