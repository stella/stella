import { Result } from "better-result";
import {
  ArchiveIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  FileOutputIcon,
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
  MenuTrigger,
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import Tooltip from "@/components/tooltip";
import { PDF_MIME_TYPE } from "@/consts";
import { api } from "@/lib/api";
import { useChatPanelStore } from "@/lib/chat-panel-store";
import type { WorkspaceEntity } from "@/lib/types";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { useDeleteEntities } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpen?: () => void;
  onRename?: () => void;
  triggerClassName?: string;
  anchor?: VirtualAnchor | null;
  /** Extra entities included in bulk actions. */
  selectedEntities?: WorkspaceEntity[];
};

export const RowActions = ({
  entity,
  workspaceId,
  open,
  onOpenChange,
  onOpen,
  onRename,
  triggerClassName,
  anchor,
  selectedEntities,
}: RowActionsProps) => {
  const t = useTranslations();
  const deleteEntities = useDeleteEntities();
  const file = getFirstFile(entity);
  const name = getEntityName(entity);
  const isFolder = entity.kind === "folder";
  const isBulk = selectedEntities !== undefined && selectedEntities.length > 1;
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
        workspaceId,
      };
    });
    useChatPanelStore.getState().requestChatAbout(mentions);
  };

  const handleDuplicate = async () => {
    const targets = isBulk ? selectedEntities : [entity];
    let failed = false;
    for (const e of targets) {
      const result = await Result.tryPromise(() =>
        api.entities({ workspaceId }).duplicate.post({
          queryKey: entitiesKeys.all(workspaceId),
          entityId: e.entityId,
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
          />
        }
      >
        <EllipsisVerticalIcon />
      </Tooltip>
      <MenuPopup anchor={anchor ?? undefined}>
        {onOpen && (
          <MenuItem onClick={onOpen}>
            <EyeIcon />
            {t("common.open")}
          </MenuItem>
        )}
        {!isBulk && onRename && (
          <MenuItem onClick={onRename}>
            <PencilIcon />
            {t("common.rename")}
          </MenuItem>
        )}
        <MenuItem onClick={handleChatAbout}>
          <MessageSquareIcon />
          {t("chat.chatAbout")}
        </MenuItem>
        {hasAnyFile && (
          <MenuItem onClick={() => handleDownload()}>
            <DownloadIcon />
            {t("common.download")}
          </MenuItem>
        )}
        {!isBulk && hasPdfConversion && (
          <MenuItem onClick={() => handleDownload(true)}>
            <FileOutputIcon />
            {t("common.saveAsPdf")}
          </MenuItem>
        )}
        {hasAnyFolder && (
          <MenuItem onClick={handleZipDownload}>
            <ArchiveIcon />
            {t("workspaces.files.downloadAsZip")}
          </MenuItem>
        )}
        <MenuItem onClick={handleDuplicate}>
          <CopyIcon />
          {t("common.duplicate")}
        </MenuItem>
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
      throw new Error("Failed to download ZIP");
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
      throw new Error("Failed to fetch file from storage");
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
