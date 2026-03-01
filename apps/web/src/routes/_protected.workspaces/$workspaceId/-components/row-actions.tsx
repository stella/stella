import { Result } from "better-result";
import {
  ArchiveIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  FileOutputIcon,
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
}: RowActionsProps) => {
  const t = useTranslations();
  const deleteEntities = useDeleteEntities();
  const file = getFirstFile(entity);
  const name = getEntityName(entity);
  const isFolder = entity.kind === "folder";
  const hasPdfConversion =
    file !== null && file.pdfFileId !== null && file.mimeType !== PDF_MIME_TYPE;

  const handleZipDownload = async () => {
    const toastId = toastManager.add({
      type: "loading",
      title: t("workspaces.files.downloadAsZip"),
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
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    toastManager.close(toastId);
    downloadFile(blobResult.value, `${name}.zip`);
  };

  const handleDownload = async (asPdf?: boolean) => {
    if (!file) {
      return;
    }

    const response = await api
      .files({ workspaceId })
      .url({ fieldId: file.fieldId })
      .get({
        query: {
          purpose: asPdf ? "display" : "download",
        },
      });

    if (response.error) {
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
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
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    const fileName = asPdf
      ? response.data.fileName.replace(EXT_RE, ".pdf")
      : response.data.fileName;
    downloadFile(blobResult.value, fileName);
  };

  const handleDuplicate = async () => {
    const result = await Result.tryPromise(() =>
      api.entities({ workspaceId }).duplicate.post({
        queryKey: entitiesKeys.all(workspaceId),
        entityId: entity.entityId,
      }),
    );

    if (Result.isError(result) || result.value.error) {
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    toastManager.add({
      title: t("common.duplicated"),
      type: "success",
    });
  };

  const handleDelete = () => {
    deleteEntities.mutate(
      { workspaceId, entityIds: [entity.entityId] },
      {
        onSuccess: () => {
          toastManager.add({
            title: `"${name}" deleted`,
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
        {onRename && (
          <MenuItem onClick={onRename}>
            <PencilIcon />
            {t("common.rename")}
          </MenuItem>
        )}
        {file && (
          <MenuItem onClick={() => handleDownload()}>
            <DownloadIcon />
            {t("common.download")}
          </MenuItem>
        )}
        {hasPdfConversion && (
          <MenuItem onClick={() => handleDownload(true)}>
            <FileOutputIcon />
            {t("common.saveAsPdf")}
          </MenuItem>
        )}
        {isFolder && (
          <MenuItem onClick={handleZipDownload}>
            <ArchiveIcon />
            {t("workspaces.files.downloadAsZip")}
          </MenuItem>
        )}
        {!isFolder && (
          <MenuItem onClick={handleDuplicate}>
            <CopyIcon />
            {t("common.duplicate")}
          </MenuItem>
        )}
        <AlertDialog>
          <AlertDialogTrigger
            render={<MenuItem closeOnClick={false} variant="destructive" />}
          >
            <Trash2Icon />
            {t("common.delete")}
          </AlertDialogTrigger>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("workspaces.deleteItem")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("common.deleteConfirmDescription", { name })}
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
