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
  HistoryIcon,
  LaptopIcon,
  LockOpenIcon,
  MessageSquareIcon,
  PencilIcon,
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
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import { useRequestChatAbout } from "@/components/chat/use-request-chat-about";
import Tooltip from "@/components/tooltip";
import { PDF_MIME_TYPE } from "@/consts";
import { env } from "@/env";
import { api } from "@/lib/api";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import { DOCX_MIME } from "@/lib/consts";
import { openDocxInDesktop } from "@/lib/desktop-bridge";
import { ClientOperationError, isUnauthorizedError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";
import { isFileDisplayable } from "@/lib/types";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { useEntitiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import {
  useCreateEntities,
  useDeleteEntities,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const EXT_RE = /\.[^.]+$/;

type VirtualAnchor = {
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
}: RowActionsProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const deleteEntities = useDeleteEntities();
  const requestChatAbout = useRequestChatAbout(workspaceId);
  const file = getFirstFile(entity);
  const name = getEntityName(entity);
  const isFolder = entity.kind === "folder";
  const isBulk = selectedEntities !== undefined && selectedEntities.length > 1;
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
          to: "/workspaces/$workspaceId/$viewId/pdf",
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
          useInspectorStore.getState().openTask(entity.entityId, name);
      }
      if (file && isFileDisplayable(file)) {
        return () =>
          useInspectorStore.getState().openPdf({
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

      toastManager.add({
        description: t("workspaces.files.desktopEdit.openedDescription"),
        title: t("workspaces.files.desktopEdit.openedTitle"),
        type: "success",
      });
    } catch (error) {
      if (error instanceof Error && isUnauthorizedError(error)) {
        toastManager.add({
          description: t(
            "workspaces.files.desktopEdit.authRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.authRequiredTitle"),
          type: "error",
        });
        return;
      }

      toastManager.add({
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

    toastManager.add({
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
      const toastId = toastManager.add({
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
        toastManager.close(toastId);
        void doForceTakeover();
      }, 30_000);
    } catch {
      try {
        await doForceTakeover();
      } catch (forceError) {
        if (forceError instanceof Error && isUnauthorizedError(forceError)) {
          toastManager.add({
            description: t(
              "workspaces.files.desktopEdit.authRequiredDescription",
            ),
            title: t("workspaces.files.desktopEdit.authRequiredTitle"),
            type: "error",
          });
          return;
        }

        toastManager.add({
          description: t("workspaces.files.desktopEdit.unavailableDescription"),
          title: t("workspaces.files.desktopEdit.unavailableTitle"),
          type: "error",
        });
      }
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
    const targets = isBulk ? selectedEntities : [entity];
    let failed = false;
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
        failed = true;
      }
    }

    toastManager.add({
      title: failed ? t("errors.actionFailed") : t("common.duplicated"),
      type: failed ? "error" : "success",
    });
  };

  const handleDelete = () => {
    const ids = isBulk
      ? selectedEntities.map((e) => e.entityId)
      : [entity.entityId];
    deleteEntities.mutate(
      { workspaceId, entityIds: ids },
      {
        onSuccess: () => {
          toastManager.add({
            title: isBulk
              ? t("common.deletedCount", { count: ids.length })
              : `"${name}" deleted`,
            type: "success",
          });
        },
        onError: () => {
          toastManager.add({
            title: "Failed to delete",
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
        content="Actions"
        render={
          <MenuTrigger
            className={
              triggerClassName ??
              "opacity-0! transition-opacity group-hover/row:opacity-100!"
            }
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
        {!isBulk && isFolder && onSubfolderCreated && (
          <CreateSubfolderMenuItem
            entity={entity}
            onSubfolderCreated={onSubfolderCreated}
            workspaceId={workspaceId}
          />
        )}
        {canOpenInDesktop && (
          // eslint-disable-next-line typescript/no-misused-promises
          <MenuItem onClick={handleOpenInDesktop}>
            <LaptopIcon />
            {t("workspaces.files.desktopEdit.action")}
          </MenuItem>
        )}
        {isLockedByOther && (
          // eslint-disable-next-line typescript/no-misused-promises
          <MenuItem onClick={handleReleaseLock}>
            <LockOpenIcon />
            {t("workspaces.files.desktopEdit.releaseLock")}
          </MenuItem>
        )}

        <MenuSeparator />

        {/* --- Features --- */}
        {!isBulk && !isFolder && entity.kind !== "task" && file && (
          <MenuItem onClick={openVersionHistory}>
            <HistoryIcon />
            {t("fileDetail.viewVersionHistory")}
          </MenuItem>
        )}
        <MenuItem onClick={handleChatAbout}>
          <MessageSquareIcon />
          {t("chat.chatAbout")}
        </MenuItem>

        <MenuSeparator />

        {/* --- File operations --- */}
        {hasAnyFile && (
          // eslint-disable-next-line typescript/no-misused-promises
          <MenuItem onClick={async () => await handleDownload()}>
            <DownloadIcon />
            {t("common.download")}
          </MenuItem>
        )}
        {!isBulk && hasPdfConversion && (
          // eslint-disable-next-line typescript/no-misused-promises
          <MenuItem onClick={async () => await handleDownload(true)}>
            <FileOutputIcon />
            {t("common.saveAsPdf")}
          </MenuItem>
        )}
        {hasAnyFolder && (
          // eslint-disable-next-line typescript/no-misused-promises
          <MenuItem onClick={handleZipDownload}>
            <ArchiveIcon />
            {t("workspaces.files.downloadAsZip")}
          </MenuItem>
        )}
        {/* eslint-disable-next-line typescript/no-misused-promises */}
        <MenuItem onClick={handleDuplicate}>
          <CopyIcon />
          {t("common.duplicate")}
        </MenuItem>

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
                render={<Button onClick={handleDelete} variant="destructive" />}
              >
                {t("common.delete")}
              </AlertDialogClose>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </MenuPopup>
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
  const isWorkflowRunning = useIsWorkflowRunning();
  const isEntitiesLimitReached = useEntitiesCountLimit();

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
          toastManager.add({
            title: t("success.folderCreated"),
            type: "success",
          });
          if (data?.entityId !== undefined) {
            onSubfolderCreated(data.entityId, entity.entityId);
          }
        },
        onError: () => {
          toastManager.add({
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

type FileRef = { fieldId: string; mimeType: string | null };
type Msg = { downloading: string; failed: string };

const downloadEntityAsZip = async (
  workspaceId: string,
  entity: WorkspaceEntity,
  msg: Msg,
) => {
  const name = getEntityName(entity);
  const toastId = toastManager.add({
    type: "loading",
    title: msg.downloading,
  });

  const blobResult = await Result.tryPromise(async () => {
    const response = await fetch(
      `/api/entities/${workspaceId}/zip/${entity.entityId}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      throw new ClientOperationError({
        action: "downloadEntityAsZip",
        message: "Failed to download ZIP",
      });
    }
    return await response.blob();
  });

  if (Result.isError(blobResult)) {
    toastManager.update(toastId, {
      title: msg.failed,
      type: "error",
    });
    return;
  }

  toastManager.close(toastId);
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
    toastManager.add({ title: msg.failed, type: "error" });
    return;
  }

  const blobResult = await Result.tryPromise(async () => {
    const s3Response = await fetch(response.data.presignedUrl);
    if (!s3Response.ok) {
      throw new ClientOperationError({
        action: "downloadSingleFile",
        message: "Failed to fetch file from storage",
      });
    }
    return await s3Response.blob();
  });

  if (Result.isError(blobResult)) {
    toastManager.add({ title: msg.failed, type: "error" });
    return;
  }

  const fileName = asPdf
    ? response.data.fileName.replace(EXT_RE, ".pdf")
    : response.data.fileName;
  downloadFile(blobResult.value, fileName);
};
