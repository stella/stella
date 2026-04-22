import { createFileRoute, redirect } from "@tanstack/react-router";

import { ensureCriticalQueryData } from "@/lib/react-query";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

/**
 * Legacy entity detail route. Redirects to the unified PDF reader
 * with the versions sidebar open.
 */
export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/entities/$entityId",
)({
  beforeLoad: async ({ context, params }) => {
    const data = await ensureCriticalQueryData(
      context.queryClient,
      entityVersionsOptions({
        workspaceId: params.workspaceId,
        entityId: params.entityId,
      }),
    );

    // Find the current version's file field ID
    const currentVersion = data.versions.find(
      (v) => v.id === data.currentVersionId,
    );
    const fieldId = currentVersion?.file?.fieldId;

    if (!fieldId) {
      // No viewable file; fall back to the workspace root
      throw redirect({
        to: "/workspaces/$workspaceId/$viewId",
        params: { workspaceId: params.workspaceId, viewId: "all" },
      });
    }

    throw redirect({
      to: "/workspaces/$workspaceId/$viewId/pdf",
      params: { workspaceId: params.workspaceId, viewId: "all" },
      search: {
        entity: params.entityId,
        field: fieldId,
        panel: "versions" as const,
      },
    });
  },
});
