import type { PropsWithChildren } from "react";

import { useQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { FileDropZone } from "@/components/file-drop-zone";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
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

  return (
    <FileDropZone
      label={t("workspaces.dropToUploadFiles")}
      onDrop={(files) => {
        if (isPending) {
          return;
        }
        createFileEntities({ files, parentId: uploadParentId });
      }}
      onDropTree={(tree) => {
        if (isPending) {
          return;
        }
        createFileEntities({ tree, parentId: uploadParentId });
      }}
    >
      {children}
    </FileDropZone>
  );
};
