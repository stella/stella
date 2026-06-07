import type { PropsWithChildren } from "react";

import { useQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useExternalFileDrop } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-external-file-drop";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

import { resolveWorkspaceDropUploadParentId } from "./workspace-drop-zone.logic";

type WorkspaceDropZoneProps = PropsWithChildren<{
  workspaceId: string;
}>;

export const WorkspaceDropZone = ({
  workspaceId,
  children,
}: WorkspaceDropZoneProps) => {
  const t = useTranslations();
  const [isPending, createFileEntities] = useCreateFileEntities(workspaceId);
  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const { data: views } = useQuery(viewsOptions(workspaceId));
  const activeViewId = viewMatch?.params.viewId;
  const activeView = activeViewId
    ? views?.find((view) => view.id === activeViewId)
    : undefined;
  const uploadParentId = resolveWorkspaceDropUploadParentId({
    activeViewLayoutType: activeView?.layout.type,
    currentFolderId: viewMatch?.search.folder,
  });
  const { ref, isDropTarget, isInnerActive } = useExternalFileDrop({
    onDrop: (files) => {
      if (isPending) {
        return;
      }
      createFileEntities({ files, parentId: uploadParentId });
    },
    onDropTree: (tree) => {
      if (isPending) {
        return;
      }
      createFileEntities({ tree, parentId: uploadParentId });
    },
  });

  const showOverlay = isDropTarget && !isInnerActive;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" ref={ref}>
      {children}
      {showOverlay && (
        <div className="border-foreground/20 bg-foreground/5 pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed">
          <div className="text-foreground-subtle flex flex-col items-center gap-2">
            <UploadIcon className="size-8" />
            <span className="text-sm font-medium">
              {t("workspaces.dropToUploadFiles")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
