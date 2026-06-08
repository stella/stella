/**
 * VersionsFacet — version history rendered inside the inspector
 * tab. Switching versions swaps the file shown in the SAME
 * inspector tab via `openFileForEntity`; we never navigate routes
 * or push a new tab. When the user is on the document route,
 * the route URL is also updated so the URL stays in sync with the
 * version actually being viewed (back/forward + reload preserve
 * the selection). Compare is owned by the document route.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import { VersionsSidebar } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/versions-sidebar";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

type VersionsFacetProps = {
  workspaceId: string;
  entityId: string;
  currentFieldId: string;
};

export const VersionsFacet = ({
  workspaceId,
  entityId,
  currentFieldId,
}: VersionsFacetProps) => {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const openFileForEntity = useInspectorStore((s) => s.openFileForEntity);
  const { data } = useQuery(entityVersionsOptions({ workspaceId, entityId }));

  if (!data) {
    return null;
  }

  return (
    <div className="bg-background h-full overflow-y-auto">
      <VersionsSidebar
        currentFieldId={currentFieldId}
        currentVersionId={data.currentVersionId}
        entityId={entityId}
        isComparing={false}
        versions={data.versions}
        workspaceId={workspaceId}
        onClearCompare={() => {
          // No-op; compare flow is owned by the document route.
        }}
        onSwitchVersion={async (fieldId, versionId) => {
          const target = data.versions.find((v) => v.id === versionId);
          if (!target?.file) {
            return;
          }
          openFileForEntity({
            id: fieldId,
            entityId,
            label: target.file.fileName,
            fileName: target.file.fileName,
            mimeType: target.file.mimeType,
            pdfFileId: null,
            propertyId: target.file.propertyId,
            workspaceId,
          });
          // If we're already on the document route, sync the URL
          // search so reload + back/forward keep the same version.
          // On non-document routes (matters table inspector), we
          // intentionally do NOT navigate — the user picked a
          // version from sidepeek and expects to stay where they
          // are.
          // Detect "we're on the document route" by structure, not
          // by entityId-as-segment: the path is
          // `/workspaces/{workspaceId}/{viewId}/document` where
          // viewId is the view selector (typically "all"), not the
          // entity id. The previous literal `${entityId}` check
          // never matched in normal navigation, so version switches
          // skipped the URL sync.
          const onDocumentRoute = new RegExp(
            `^/workspaces/${workspaceId}/[^/]+/document(?:/|$|\\?)`,
            "u",
          ).test(pathname);
          if (onDocumentRoute) {
            // Pull the current viewId out of the path (typically
            // "all") instead of swapping it for entityId — the
            // route lives under whichever view the user opened it
            // from, the entity is identified by the search param.
            const segments = pathname.split("/");
            const currentViewId = segments[3] ?? "all";
            await navigate({
              to: "/workspaces/$workspaceId/$viewId/document",
              params: { workspaceId, viewId: currentViewId },
              replace: true,
              search: (prev) => ({
                ...prev,
                entity: entityId,
                editing: undefined,
                field: fieldId,
                pdfPage: undefined,
              }),
            });
          }
        }}
      />
    </div>
  );
};
