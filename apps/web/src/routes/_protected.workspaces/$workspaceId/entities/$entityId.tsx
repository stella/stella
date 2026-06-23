import { useQuery } from "@tanstack/react-query";
import { Navigate, createFileRoute } from "@tanstack/react-router";

import { DocxLoadingShell } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-loading-shell";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

/**
 * Legacy entity detail route. Resolves the current file field after the
 * protected shell commits, then redirects to the unified PDF reader with the
 * versions sidebar open.
 */
export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/entities/$entityId",
)({
  component: LegacyEntityRedirect,
});

function LegacyEntityRedirect() {
  const { workspaceId, entityId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, entityId: p.entityId }),
  });
  const versionDataQuery = useQuery(
    entityVersionsOptions({ workspaceId, entityId }),
  );

  if (versionDataQuery.isPending) {
    return <DocxLoadingShell />;
  }

  if (versionDataQuery.isError) {
    throw versionDataQuery.error;
  }

  const currentVersion = versionDataQuery.data.versions.find(
    (v) => v.id === versionDataQuery.data.currentVersionId,
  );
  const fieldId = currentVersion?.file?.fieldId;

  if (!fieldId) {
    return (
      <Navigate
        params={{ workspaceId, viewId: "all" }}
        to="/workspaces/$workspaceId/$viewId"
      />
    );
  }

  return (
    <Navigate
      params={{ workspaceId, viewId: "all" }}
      search={{
        entity: entityId,
        field: fieldId,
        panel: "versions" as const,
      }}
      to="/workspaces/$workspaceId/$viewId/document"
    />
  );
}
