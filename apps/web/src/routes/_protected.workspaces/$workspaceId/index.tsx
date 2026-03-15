import { createFileRoute, redirect } from "@tanstack/react-router";

import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient;
    const views = await qc.ensureQueryData(
      viewsOptions(params.workspaceId, qc),
    );

    const firstView = views[0];
    if (!firstView) {
      throw new Error("Workspace has no views");
    }

    throw redirect({
      to: "/workspaces/$workspaceId/$viewId",
      params: {
        workspaceId: params.workspaceId,
        viewId: firstView.id,
      },
    });
  },
});
