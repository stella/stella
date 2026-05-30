import type React from "react";
import { useState } from "react";

import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { VersionOrNewFileDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useExternalFileDrop } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-external-file-drop";
import { useUploadVersion } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-upload-version";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type UseRowFileVersionDropOptions = {
  entity: TableTreeNode;
  workspaceId: string;
  rowRef: React.RefObject<HTMLDivElement | null>;
};

type UseRowFileVersionDropResult = {
  isDropTarget: boolean;
  dialog: React.ReactNode;
};

/**
 * Wires external single-file drops on a row to the
 * version-or-new-file dialog. Disabled for folders, tasks, and
 * entities without a file; mismatched MIME types and multi-file
 * drops fall through to the workspace `DropZone`.
 */
export const useRowFileVersionDrop = ({
  entity,
  workspaceId,
  rowRef,
}: UseRowFileVersionDropOptions): UseRowFileVersionDropResult => {
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const uploadVersion = useUploadVersion();
  const [, createFileEntities] = useCreateFileEntities(workspaceId);

  const file = getFirstFile(entity);
  const canAcceptDrop =
    entity.kind !== "folder" && entity.kind !== "task" && file !== null;
  const expectedMimeType = file?.mimeType.toLowerCase() ?? null;

  const { isDropTarget } = useExternalFileDrop({
    id: entity.entityId,
    enabled: canAcceptDrop,
    externalRef: rowRef,
    accept: (info) =>
      info.fileCount === 1 &&
      expectedMimeType !== null &&
      info.mimeTypes[0] === expectedMimeType,
    onDrop: (files) => {
      const next = files[0];
      if (next) {
        setDroppedFile(next);
      }
    },
  });

  const closeDialog = () => setDroppedFile(null);

  const handleReplaceVersion = () => {
    if (!droppedFile || !file) {
      return;
    }
    uploadVersion.mutate(
      {
        workspaceId,
        entityId: entity.entityId,
        entityFileName: file.fileName,
        file: droppedFile,
      },
      { onSettled: closeDialog },
    );
  };

  const handleCreateNewFile = () => {
    if (!droppedFile) {
      return;
    }
    createFileEntities([droppedFile]);
    closeDialog();
  };

  const dialog =
    droppedFile && file ? (
      <VersionOrNewFileDialog
        droppedFile={droppedFile}
        entityFileName={file.fileName}
        isReplacePending={uploadVersion.isPending}
        onCreateNewFile={handleCreateNewFile}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        onReplaceVersion={handleReplaceVersion}
        open
      />
    ) : null;

  return { isDropTarget, dialog };
};
