import { createFileRoute, redirect } from "@tanstack/react-router";

import { ensureCriticalQueryData } from "@/lib/react-query";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient;
    const opts = viewsOptions(params.workspaceId);

    // Invalidate first to avoid serving stale cache from a
    // previous workspace that had no views.
    await qc.invalidateQueries({ queryKey: opts.queryKey });

    const views = await ensureCriticalQueryData(qc, opts);

    const firstView = views.at(0);
    if (!firstView) {
      throw redirect({ to: "/workspaces", replace: true });
    }

    throw redirect({
      to: "/workspaces/$workspaceId/$viewId",
      params: {
        workspaceId: params.workspaceId,
        viewId: firstView.id,
      },
      replace: true,
    });
  },
});
