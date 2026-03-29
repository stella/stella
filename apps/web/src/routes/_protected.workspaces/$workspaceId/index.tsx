import { createFileRoute, redirect } from "@tanstack/react-router";
import { panic } from "better-result";

import { sessionOptions } from "@/routes/-queries";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  beforeLoad: async ({ context, params }) => {
    const qc = context.queryClient;
    const session = await qc.ensureQueryData(sessionOptions);

    if (!session?.session.activeOrganizationId) {
      panic("No active organization");
    }

    const views = await qc.ensureQueryData(
      viewsOptions({
        key: { workspaceId: params.workspaceId },
        context: {
          organizationId: session.session.activeOrganizationId,
          authToken: session.session.token,
        },
      }),
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
