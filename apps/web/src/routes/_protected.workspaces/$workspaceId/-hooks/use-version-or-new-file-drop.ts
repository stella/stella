import type React from "react";
import { useState } from "react";

import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useExternalFileDrop } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-external-file-drop";
import { useUploadVersion } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-upload-version";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type UseVersionOrNewFileDropOptions = {
  entity: TableTreeNode;
  workspaceId: string;
  rowRef: React.RefObject<HTMLDivElement | null>;
};

type PendingVersionDrop = {
  open: boolean;
  droppedFile: File;
  entityFileName: string;
  isReplacePending: boolean;
  onReplaceVersion: () => void;
  onCreateNewFile: () => void;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
};

type UseVersionOrNewFileDropResult = {
  isDropTarget: boolean;
  /** Non-null when a file has been dropped and is awaiting the user's choice. */
  pendingDrop: PendingVersionDrop | null;
};

/**
 * Wires external file drops on a file row to the version-or-new
 * resolution flow. Returns the drop session state; the caller renders
 * `<VersionOrNewFileDialog>` from it. Disabled for folders, tasks, and
 * entities without a file. Single-file drops open the dialog (which
 * decides replace-vs-new via extension match); multi-file drops bypass
 * the dialog and create new file entities directly, since a row
 * represents one file and cannot be replaced by many.
 */
export const useVersionOrNewFileDrop = ({
  entity,
  workspaceId,
  rowRef,
}: UseVersionOrNewFileDropOptions): UseVersionOrNewFileDropResult => {
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const uploadVersion = useUploadVersion();
  const [, createFileEntities] = useCreateFileEntities(workspaceId);

  const file = getFirstFile(entity);
  const canAcceptDrop =
    entity.kind !== "folder" &&
    entity.kind !== "task" &&
    !entity.readOnly &&
    file !== null;

  const { isDropTarget } = useExternalFileDrop({
    enabled: canAcceptDrop,
    externalRef: rowRef,
    onDrop: (files) => {
      if (files.length === 1) {
        const next = files[0];
        if (next) {
          setDroppedFile(next);
          setIsOpen(true);
        }
        return;
      }
      createFileEntities(files);
    },
  });

  const closeDialog = () => setIsOpen(false);

  const pendingDrop: PendingVersionDrop | null =
    droppedFile && file
      ? {
          open: isOpen,
          droppedFile,
          entityFileName: file.fileName,
          isReplacePending: uploadVersion.isPending,
          onReplaceVersion: () => {
            uploadVersion.mutate(
              {
                workspaceId,
                entityId: entity.entityId,
                entityFileName: file.fileName,
                file: droppedFile,
              },
              { onSettled: closeDialog },
            );
          },
          onCreateNewFile: () => {
            createFileEntities([droppedFile]);
            closeDialog();
          },
          onOpenChange: setIsOpen,
          onOpenChangeComplete: (open) => {
            if (!open) {
              setDroppedFile(null);
            }
          },
        }
      : null;

  return { isDropTarget, pendingDrop };
};
