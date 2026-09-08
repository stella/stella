import type React from "react";
import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import { getFirstFile } from "@/components/workspaces/entity-utils";
import type { TableTreeNode } from "@/components/workspaces/table/types";
import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import type { DocumentReferenceMatch } from "@/lib/document-reference-queries";
import { resolveFileDocumentReference } from "@/lib/document-reference-queries";
import {
  REFERENCE_CHECK,
  useCreateFileEntities,
} from "@/lib/workspaces/mutations/use-create-file-entities";
import type { VersionOrNewFileDialogProps } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog";
import type { VersionOrNewFileChoice } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog.logic";
import {
  resolveVersionOrNewFileDecision,
  VERSION_OR_NEW_FILE_CHOICE,
} from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog.logic";
import { useUploadVersion } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-upload-version";

type UseVersionOrNewFileDropOptions = {
  entity: TableTreeNode;
  workspaceId: string;
  rowRef: React.RefObject<HTMLDivElement | null>;
};

type DroppedFileResolution =
  | { status: "resolving" }
  | { status: "resolved"; match: DocumentReferenceMatch | null };

type PendingDrop = {
  file: File;
  resolution: DroppedFileResolution;
};

type UseVersionOrNewFileDropResult = {
  isDropTarget: boolean;
  /**
   * Non-null when a file has been dropped and is awaiting the user's choice.
   * Spread straight onto `<VersionOrNewFileDialog>`; deriving it from that
   * component's own props keeps the two from drifting.
   */
  pendingDrop: VersionOrNewFileDialogProps | null;
};

/**
 * Wires external file drops on a file row to the version-or-new resolution
 * flow. Returns the drop session state; the caller renders
 * `<VersionOrNewFileDialog>` from it. Disabled for folders, tasks, and
 * documents without a file.
 *
 * A dropped DOCX that left stella carries its own reference, so the dialog
 * asks the file which document it belongs to before falling back to comparing
 * extensions — including when it belongs to a document other than the row it
 * landed on, which no filename heuristic could ever have noticed.
 *
 * Multi-file drops bypass the dialog and go to `useCreateFileEntities`, which
 * runs its own reference check: a row represents one file and cannot be
 * replaced by many.
 */
export const useVersionOrNewFileDrop = ({
  entity,
  workspaceId,
  rowRef,
}: UseVersionOrNewFileDropOptions): UseVersionOrNewFileDropResult => {
  const [drop, setDrop] = useState<PendingDrop | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const uploadVersion = useUploadVersion();
  const [, createFileEntities] = useCreateFileEntities(workspaceId);

  const file = getFirstFile(entity);
  const canAcceptDrop =
    entity.kind !== "folder" &&
    entity.kind !== "task" &&
    !entity.readOnly &&
    file !== null;

  const resolveReference = async (dropped: File): Promise<void> => {
    const result = await Result.tryPromise(
      async () => await resolveFileDocumentReference(queryClient, dropped),
    );
    if (Result.isError(result)) {
      // A failed lookup costs the offer to file this as a version, not the
      // upload: the dialog falls back to comparing extensions.
      analytics.captureError(result.error);
    }

    setDrop((current) =>
      // The user may have dropped another file while this was in flight; that
      // drop owns the dialog now, and this answer is about a file nobody is
      // looking at.
      current?.file === dropped
        ? {
            file: dropped,
            resolution: {
              status: "resolved",
              match: Result.isError(result) ? null : result.value,
            },
          }
        : current,
    );
  };

  const openDialogFor = (dropped: File) => {
    setDrop({ file: dropped, resolution: { status: "resolving" } });
    setIsOpen(true);
    detached(
      resolveReference(dropped),
      "use-version-or-new-file-drop.resolve-reference",
    );
  };

  const { isDropTarget } = useExternalFileDrop({
    enabled: canAcceptDrop,
    externalRef: rowRef,
    onDrop: (files) => {
      createFileEntities({ files, parentId: entity.parentId ?? null });
    },
    onDropTree: (tree) => {
      if (tree.directoryPaths.length === 0 && tree.files.length === 1) {
        const next = tree.files.at(0)?.file;
        if (next) {
          openDialogFor(next);
        }
        return;
      }
      createFileEntities({ tree, parentId: entity.parentId ?? null });
    },
  });

  if (drop === null || file === null) {
    return { isDropTarget, pendingDrop: null };
  }

  const closeDialog = () => setIsOpen(false);
  const decision =
    drop.resolution.status === "resolved"
      ? resolveVersionOrNewFileDecision({
          match: drop.resolution.match,
          droppedOnEntityId: entity.entityId,
          entityFileName: file.fileName,
          droppedFileName: drop.file.name,
        })
      : null;

  const choose = (choice: VersionOrNewFileChoice) => {
    switch (choice) {
      case VERSION_OR_NEW_FILE_CHOICE.newDocument: {
        createFileEntities({
          files: [drop.file],
          parentId: entity.parentId ?? null,
          // This dialog just asked; the batch prompt must not ask again.
          referenceCheck: REFERENCE_CHECK.skip,
        });
        closeDialog();
        return;
      }
      case VERSION_OR_NEW_FILE_CHOICE.versionHere: {
        uploadVersion.mutate(
          {
            workspaceId,
            entityId: entity.entityId,
            entityFileName: file.fileName,
            file: drop.file,
          },
          { onSettled: closeDialog },
        );
        return;
      }
      case VERSION_OR_NEW_FILE_CHOICE.versionElsewhere: {
        if (decision?.type !== "reference-elsewhere") {
          return panic(
            "Chose to file a version elsewhere with no other document resolved",
          );
        }
        const { document } = decision;
        uploadVersion.mutate(
          {
            workspaceId: document.workspaceId,
            entityId: document.entityId,
            // For a file entity the document's name is its filename, which is
            // all the extension pre-check reads.
            entityFileName: document.documentName,
            file: drop.file,
          },
          { onSettled: closeDialog },
        );
        return;
      }
      default: {
        choice satisfies never;
      }
    }
  };

  return {
    isDropTarget,
    pendingDrop: {
      open: isOpen,
      droppedFileName: drop.file.name,
      decision,
      isUploadPending: uploadVersion.isPending,
      onChoose: choose,
      onOpenChange: setIsOpen,
      onOpenChangeComplete: (open) => {
        if (!open) {
          setDrop(null);
        }
      },
    },
  };
};
