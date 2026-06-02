import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  ArchiveIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  FileOutputIcon,
  FolderPlusIcon,
  FolderSyncIcon,
  LaptopIcon,
  LockOpenIcon,
  Maximize2Icon,
  MessageSquareIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";

import { useRequestChatAbout } from "@/components/chat/use-request-chat-about";
import Tooltip from "@/components/tooltip";
import { PDF_MIME_TYPE } from "@/consts";
import { env } from "@/env";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import { DOCX_MIME } from "@/lib/consts";
import { openDocxInDesktop } from "@/lib/desktop-bridge";
import { ClientOperationError, isUnauthorizedError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceCellMetadata, WorkspaceEntity } from "@/lib/types";
import { isFileDisplayable } from "@/lib/types";
import {
  CellLockMenuItem,
  CellMetadataMenuSection,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { CopyToMatterDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/copy-to-matter-dialog";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { getPdfDownloadFileName } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions.logic";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { useEntitiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useRetryCell } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-retry-cell";
import {
  useCreateEntities,
  useDeleteEntities,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

export type VirtualAnchor = {
  getBoundingClientRect: () => DOMRect;
};

type RowActionsProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  onOpen?: (() => void) | undefined;
  onRename?: (() => void) | undefined;
  onSubfolderCreated?:
    | ((entityId: string, parentId: string) => void)
    | undefined;
  triggerClassName?: string | undefined;
  triggerTabIndex?: number | undefined;
  anchor?: VirtualAnchor | null | undefined;
  /** Extra entities included in bulk actions. */
  selectedEntities?: WorkspaceEntity[] | undefined;
  cellMetadataTarget?:
    | { propertyId: string; metadata: WorkspaceCellMetadata | undefined }
    | null
    | undefined;
};

export const RowActions = ({
  entity,
  workspaceId,
  open,
  onOpenChange,
  onOpen,
  onRename,
  onSubfolderCreated,
  triggerClassName,
  triggerTabIndex,
  anchor,
  selectedEntities,
  cellMetadataTarget,
}: RowActionsProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const deleteEntities = useDeleteEntities();
  const requestChatAbout = useRequestChatAbout(workspaceId);
  const retryCell = useRetryCell(workspaceId);
  const [copyToMatterOpen, setCopyToMatterOpen] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const { data: properties } = useQuery(propertiesOptions(workspaceId));
  const file = getFirstFile(entity);
  const name = getEntityName(entity);
  const isFolder = entity.kind === "folder";
  const isBulk = selectedEntities !== undefined && selectedEntities.length > 1;
  const isCellContext =
    !isBulk && cellMetadataTarget !== null && cellMetadataTarget !== undefined;
  const isDocx = !isBulk && file?.mimeType === DOCX_MIME;
  const isLockedByMe =
    isDocx && entity.activeEditBy !== null && entity.activeEditBy.isMe;
  const isLockedByOther =
    isDocx && entity.activeEditBy !== null && !entity.activeEditBy.isMe;
  // Show "Edit in Desktop" when: DOCX + (not locked OR locked by me)
  const canOpenInDesktop = isDocx && !isLockedByOther;

  const openVersionHistory = file
    ? () => {
        useWorkspaceStore.getState().setPdfViewerState({
          sidebar: "versions",
        });
        void navigate({
          to: "/workspaces/$workspaceId/$viewId/document",
          params: { workspaceId, viewId: "all" },
          search: {
            entity: entity.entityId,
            field: file.fieldId,
            panel: "versions" as const,
          },
        });
      }
    : undefined;

  // Derive a default open handler when the caller doesn't
  // provide one. Tasks open in the inspector; displayable
  // files open in the PDF peek viewer.
  const resolvedOnOpen =
    onOpen ??
    (() => {
      if (entity.kind === "task") {
        return () =>
          useInspectorStore.getState().openTask({
            taskId: entity.entityId,
            workspaceId,
            label: name,
          });
      }
      if (file && isFileDisplayable(file)) {
        return () =>
          useInspectorStore.getState().openFile({
            id: file.fieldId,
            entityId: file.entityId,
            label: name,
            mimeType: file.mimeType,
            pdfFileId: file.pdfFileId,
            propertyId: file.propertyId,
            workspaceId,
          });
      }
      return undefined;
    })();

  const hasPdfConversion =
    file !== null && file.pdfFileId !== null && file.mimeType !== PDF_MIME_TYPE;

  const msg: Msg = {
    downloading: t("workspaces.files.downloadAsZip"),
    failed: t("errors.actionFailed"),
  };

  const handleZipDownload = async () => {
    if (isBulk) {
      for (const e of selectedEntities) {
        await downloadEntityAsZip(workspaceId, e, msg);
      }
      return;
    }

    await downloadEntityAsZip(workspaceId, entity, msg);
  };

  const handleDownload = async (asPdf?: boolean) => {
    if (isBulk) {
      for (const e of selectedEntities) {
        const f = getFirstFile(e);
        if (f) {
          await downloadSingleFile(workspaceId, f, asPdf, msg);
        }
      }
      return;
    }

    if (file) {
      await downloadSingleFile(workspaceId, file, asPdf, msg);
    }
  };

  const handleOpenInDesktop = async () => {
    if (!file || file.mimeType !== DOCX_MIME) {
      return;
    }

    try {
      const linkedAccount = await getFreshLinkedAccount();

      const desktopInput = {
        apiBaseUrl: env.VITE_API_URL,
        entityId: file.entityId,
        linkedAccount,
        propertyId: file.propertyId,
        workspaceId,
        ...(isLockedByMe ? { force: true as const } : {}),
      };

      await openDocxInDesktop(desktopInput);

      stellaToast.add({
        description: t("workspaces.files.desktopEdit.openedDescription"),
        title: t("workspaces.files.desktopEdit.openedTitle"),
        type: "success",
      });
    } catch (error) {
      if (error instanceof Error && isUnauthorizedError(error)) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.authRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.authRequiredTitle"),
          type: "error",
        });
        return;
      }

      stellaToast.add({
        description: t("workspaces.files.desktopEdit.unavailableDescription"),
        title: t("workspaces.files.desktopEdit.unavailableTitle"),
        type: "error",
      });
    }
  };

  const doForceTakeover = async () => {
    if (!file || file.mimeType !== DOCX_MIME) {
      return;
    }

    const linkedAccount = await getFreshLinkedAccount();

    await openDocxInDesktop({
      apiBaseUrl: env.VITE_API_URL,
      entityId: file.entityId,
      force: true,
      linkedAccount,
      propertyId: file.propertyId,
      workspaceId,
    });

    stellaToast.add({
      description: t("workspaces.files.desktopEdit.openedDescription"),
      title: t("workspaces.files.desktopEdit.openedTitle"),
      type: "success",
    });
  };

  const handleReleaseLock = async () => {
    if (!file || file.mimeType !== DOCX_MIME) {
      return;
    }

    const lockedByName = entity.activeEditBy?.name ?? "";

    try {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["desktop-edit-sessions"]["request-takeover"].post({
          entityId: toSafeId<"entity">(file.entityId),
          propertyId: toSafeId<"property">(file.propertyId),
        });

      if (response.error) {
        // No active session or other error — force release
        await doForceTakeover();
        return;
      }

      // Consent request sent — show waiting toast with 30s timeout
      const toastId = stellaToast.add({
        title: t("workspaces.files.desktopEdit.takeoverWaiting"),
        description: t(
          "workspaces.files.desktopEdit.takeoverWaitingDescription",
          { name: lockedByName },
        ),
        type: "loading",
      });

      // After 30 seconds, close the waiting toast and force-release.
      // If the lock holder responds before the timeout, the SSE
      // invalidate-query broadcast refetches the entity list and
      // the "Release lock" option disappears; the loading toast
      // becomes stale but harmless (force-release on an already-
      // released lock is a no-op on the API side).
      setTimeout(() => {
        stellaToast.close(toastId);
        void doForceTakeover();
      }, 30_000);
    } catch {
      try {
        await doForceTakeover();
      } catch (forceError) {
        if (forceError instanceof Error && isUnauthorizedError(forceError)) {
          stellaToast.add({
            description: t(
              "workspaces.files.desktopEdit.authRequiredDescription",
            ),
            title: t("workspaces.files.desktopEdit.authRequiredTitle"),
            type: "error",
          });
          return;
        }

        stellaToast.add({
          description: t("workspaces.files.desktopEdit.unavailableDescription"),
          title: t("workspaces.files.desktopEdit.unavailableTitle"),
          type: "error",
        });
      }
    }
  };

  const cellProperty =
    cellMetadataTarget && properties
      ? properties.find((p) => p.id === cellMetadataTarget.propertyId)
      : undefined;
  const cellField = cellMetadataTarget
    ? entity.fields[cellMetadataTarget.propertyId]
    : undefined;
  const canRetryCell =
    cellProperty?.tool.type === "ai-model" &&
    cellProperty.content.type !== "file";
  const retryDisabled =
    isRetrying ||
    entity.readOnly ||
    cellMetadataTarget?.metadata?.locked === true ||
    cellField?.content.type === "pending";

  const handleRetryCell = async () => {
    if (!cellMetadataTarget || isRetrying) {
      return;
    }
    setIsRetrying(true);
    try {
      await retryCell({
        entityId: entity.entityId,
        propertyId: cellMetadataTarget.propertyId,
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const handleChatAbout = () => {
    const targets = isBulk ? selectedEntities : [entity];
    const mentions = targets.map((e) => {
      const f = getFirstFile(e);
      return {
        id: e.entityId,
        label: getEntityName(e),
        category: "entity" as const,
        kind: e.kind,
        mimeType: f?.mimeType ?? null,
      };
    });
    requestChatAbout(mentions);
  };

  const handleDuplicate = async () => {
    const allTargets = isBulk ? selectedEntities : [entity];
    // Folders cannot be duplicated server-side; silently skip them so a
    // mixed selection (folders + files) does not surface as a generic
    // failure to the user.
    const targets = allTargets.filter((e) => e.kind !== "folder");

    if (targets.length === 0) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    let failedCount = 0;
    for (const e of targets) {
      const result = await Result.tryPromise(
        async () =>
          await api
            .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
            .duplicate.post({
              queryKey: entitiesKeys.all(workspaceId),
              entityId: toSafeId<"entity">(e.entityId),
            }),
      );
      if (Result.isError(result) || result.value.error) {
        failedCount++;
      }
    }

    if (failedCount === 0) {
      stellaToast.add({
        title: t("common.duplicated"),
        type: "success",
      });
    } else if (failedCount === targets.length) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    } else {
      stellaToast.add({
        title: t("common.duplicated"),
        description: t("errors.actionFailed"),
        type: "warning",
      });
    }
  };

  const handleDelete = () => {
    const ids = isBulk
      ? selectedEntities.map((e) => e.entityId)
      : [entity.entityId];
    deleteEntities.mutate(
      { workspaceId, entityIds: ids },
      {
        onSuccess: () => {
          stellaToast.add({
            title: isBulk
              ? t("common.deletedCount", { count: ids.length })
              : t("workspaces.deletedItem", { name }),
            type: "success",
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToDeleteEntities"),
            type: "error",
          });
        },
      },
    );
  };

  // Whether any selected entity has a downloadable file.
  const hasAnyFile = isBulk
    ? selectedEntities.some((e) => getFirstFile(e) !== null)
    : file !== null;
  const hasAnyFolder = isBulk
    ? selectedEntities.some((e) => e.kind === "folder")
    : isFolder;

  return (
    <Menu onOpenChange={onOpenChange} open={open}>
      <Tooltip
        content={t("common.actions")}
        render={
          <MenuTrigger
            className={
              triggerClassName ??
              "opacity-0! transition-opacity group-hover/row:opacity-100!"
            }
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            render={<Button size="icon-xs" variant="ghost" />}
            tabIndex={triggerTabIndex}
          />
        }
      >
        <EllipsisVerticalIcon />
      </Tooltip>
      <MenuPopup anchor={anchor ?? undefined}>
        {/* --- View / Edit --- */}
        {resolvedOnOpen && (
          <MenuItem onClick={resolvedOnOpen}>
            <EyeIcon />
            {t("common.preview")}
          </MenuItem>
        )}
        {!isBulk && onRename && (
          <MenuItem onClick={onRename}>
            <PencilIcon />
            {t("common.rename")}
          </MenuItem>
        )}
        {!isBulk && cellMetadataTarget && (
          <>
            {canRetryCell && (
              <MenuItem
                disabled={retryDisabled}
                onClick={() => void handleRetryCell()}
              >
                <RefreshCwIcon />
                {t("common.retry")}
              </MenuItem>
            )}
            <CellLockMenuItem
              entityId={entity.entityId}
              metadata={cellMetadataTarget.metadata}
              propertyId={cellMetadataTarget.propertyId}
              workspaceId={workspaceId}
            />
            <MenuSeparator />
            <CellMetadataMenuSection
              entityId={entity.entityId}
              metadata={cellMetadataTarget.metadata}
              propertyId={cellMetadataTarget.propertyId}
              workspaceId={workspaceId}
            />
          </>
        )}
        {!isCellContext && !isBulk && isFolder && onSubfolderCreated && (
          <CreateSubfolderMenuItem
            entity={entity}
            onSubfolderCreated={onSubfolderCreated}
            workspaceId={workspaceId}
          />
        )}
        {!isCellContext && canOpenInDesktop && (
          <MenuItem
            onClick={() => {
              void handleOpenInDesktop();
            }}
          >
            <LaptopIcon />
            {t("workspaces.files.desktopEdit.action")}
          </MenuItem>
        )}
        {!isCellContext && isLockedByOther && (
          <MenuItem
            onClick={() => {
              void handleReleaseLock();
            }}
          >
            <LockOpenIcon />
            {t("workspaces.files.desktopEdit.releaseLock")}
          </MenuItem>
        )}

        <MenuSeparator />

        {/* --- Features --- */}
        {!isBulk && !isFolder && entity.kind !== "task" && file && (
          <MenuItem onClick={openVersionHistory}>
            {/* Same intent as the inspector's full-view button
                (open this file in the document route — the
                versions panel is just one of the facets there).
                Match the icon + label so the two surfaces don't
                look like two different actions. */}
            <Maximize2Icon />
            {t("workspaces.pdf.fullView")}
          </MenuItem>
        )}
        <MenuItem onClick={handleChatAbout}>
          <MessageSquareIcon />
          {t("chat.chatAbout")}
        </MenuItem>

        {!isCellContext && (
          <>
            <MenuSeparator />

            {/* --- File operations --- */}
            {hasAnyFile && (isBulk || !hasPdfConversion) && (
              <MenuItem
                onClick={() => {
                  void handleDownload();
                }}
              >
                <DownloadIcon />
                {t("common.download")}
              </MenuItem>
            )}
            {!isBulk && hasPdfConversion && (
              <MenuSub>
                <MenuSubTrigger>
                  <DownloadIcon />
                  {t("common.download")}
                </MenuSubTrigger>
                <MenuSubPopup>
                  <MenuItem
                    onClick={() => {
                      void handleDownload();
                    }}
                  >
                    <DownloadIcon />
                    {t("workspaces.files.downloadOriginal")}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void handleDownload(true);
                    }}
                  >
                    <FileOutputIcon />
                    {t("workspaces.files.downloadPdf")}
                  </MenuItem>
                </MenuSubPopup>
              </MenuSub>
            )}
            {hasAnyFolder && (
              <MenuItem
                onClick={() => {
                  void handleZipDownload();
                }}
              >
                <ArchiveIcon />
                {t("workspaces.files.downloadAsZip")}
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                void handleDuplicate();
              }}
            >
              <CopyIcon />
              {t("common.duplicate")}
            </MenuItem>
            {!isBulk && (
              <MenuItem
                onClick={() => {
                  setCopyToMatterOpen(true);
                }}
              >
                <FolderSyncIcon />
                {t("workspaces.copyToMatter.menuItem")}
              </MenuItem>
            )}

            <MenuSeparator />

            {/* --- Destructive --- */}
            <AlertDialog>
              <AlertDialogTrigger
                render={<MenuItem closeOnClick={false} variant="destructive" />}
              >
                <Trash2Icon />
                {t("common.delete")}
              </AlertDialogTrigger>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {isBulk
                      ? t("workspaces.deleteItems", {
                          count: selectedEntities.length,
                        })
                      : t("workspaces.deleteItem")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {isBulk
                      ? t("workspaces.deleteItemsDescription", {
                          count: selectedEntities.length,
                        })
                      : t("common.deleteConfirmDescription", {
                          name,
                        })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="ghost" />}>
                    {t("common.cancel")}
                  </AlertDialogClose>
                  <AlertDialogClose
                    render={
                      <Button onClick={handleDelete} variant="destructive" />
                    }
                  >
                    {t("common.delete")}
                  </AlertDialogClose>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </>
        )}
      </MenuPopup>
      {!isBulk && (
        <CopyToMatterDialog
          entityId={entity.entityId}
          entityName={name}
          onOpenChange={setCopyToMatterOpen}
          open={copyToMatterOpen}
          sourceWorkspaceId={workspaceId}
        />
      )}
    </Menu>
  );
};

type CreateSubfolderMenuItemProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
  onSubfolderCreated: (entityId: string, parentId: string) => void;
};

const CreateSubfolderMenuItem = ({
  entity,
  workspaceId,
  onSubfolderCreated,
}: CreateSubfolderMenuItemProps) => {
  const t = useTranslations();
  const createEntities = useCreateEntities();
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const isEntitiesLimitReached = useEntitiesCountLimit(workspaceId);

  if (isEntitiesLimitReached) {
    return null;
  }

  const handleCreateSubfolder = () => {
    createEntities.mutate(
      {
        workspaceId,
        type: "manual-input",
        kind: "folder",
        parentId: entity.entityId,
        name: t("workspaces.newFolder"),
      },
      {
        onSuccess: (data) => {
          stellaToast.add({
            title: t("success.folderCreated"),
            type: "success",
          });
          onSubfolderCreated(data.entityId, entity.entityId);
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <MenuItem
      disabled={isWorkflowRunning || createEntities.isPending}
      onClick={handleCreateSubfolder}
    >
      <FolderPlusIcon />
      {t("workspaces.filesystem.newSubfolder")}
    </MenuItem>
  );
};

// -- Helpers (avoid duplicating logic between single/bulk) --

type FileRef = { fieldId: string; fileName: string; mimeType: string | null };
type Msg = { downloading: string; failed: string };

const downloadEntityAsZip = async (
  workspaceId: string,
  entity: WorkspaceEntity,
  msg: Msg,
) => {
  const name = getEntityName(entity);
  const toastId = stellaToast.add({
    type: "loading",
    title: msg.downloading,
  });

  const responseResult = await Result.tryPromise(
    async () =>
      await fetch(apiUrl(`/entities/${workspaceId}/zip/${entity.entityId}`), {
        credentials: "include",
        signal: AbortSignal.timeout(60_000),
      }),
  );

  if (Result.isError(responseResult)) {
    stellaToast.update(toastId, { title: msg.failed, type: "error" });
    return;
  }

  const response = responseResult.value;

  if (!response.ok) {
    stellaToast.update(toastId, { title: msg.failed, type: "error" });
    return;
  }

  const blobResult = await Result.tryPromise(async () => await response.blob());

  if (Result.isError(blobResult)) {
    stellaToast.update(toastId, { title: msg.failed, type: "error" });
    return;
  }

  stellaToast.close(toastId);
  downloadFile(blobResult.value, `${name}.zip`);
};

const downloadSingleFile = async (
  workspaceId: string,
  file: FileRef,
  asPdf: boolean | undefined,
  msg: Msg,
) => {
  const response = await api
    .files({ workspaceId })
    .url({ fieldId: file.fieldId })
    .get({ query: { purpose: asPdf ? "display" : "download" } });

  if (response.error) {
    stellaToast.add({ title: msg.failed, type: "error" });
    return;
  }

  const blobResult = await Result.tryPromise(async () => {
    const s3Response = await fetch(response.data.presignedUrl, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!s3Response.ok) {
      throw new ClientOperationError({
        action: "downloadSingleFile",
        message: "Failed to fetch file from storage",
      });
    }
    return await s3Response.blob();
  });

  if (Result.isError(blobResult)) {
    stellaToast.add({ title: msg.failed, type: "error" });
    return;
  }

  const fileName = asPdf
    ? getPdfDownloadFileName(file.fileName)
    : file.fileName;
  downloadFile(blobResult.value, fileName);
};
