import { createFileRoute, redirect } from "@tanstack/react-router";
import { panic } from "better-result";

import { ensureCriticalQueryData } from "@/lib/react-query";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient;

    const views = await ensureCriticalQueryData(
      qc,
      viewsOptions(params.workspaceId),
    );

    const firstView = views[0];
    if (!firstView) {
      panic("Workspace has no views");
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
