import { useRef } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import {
  FileTextIcon,
  FolderPlusIcon,
  PlusIcon,
  SquareCheckIcon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import type { EntityKind } from "@/lib/types";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useEntitiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useCreateEntities } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

type AddEntityMenuProps = {
  workspaceId: string;
  parentId?: string | null;
  render?: React.ReactElement;
  onFolderCreated?: (entityId: string) => void;
};

export const AddEntityMenu = ({
  workspaceId,
  parentId,
  render,
  onFolderCreated,
}: AddEntityMenuProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isWorkflowRunning = useIsWorkflowRunning();
  const isEntitiesLimitReached = useEntitiesCountLimit();
  const [isUploadPending, createFileEntities] =
    useCreateFileEntities(workspaceId);
  const { data: hasFileProperties } = useSuspenseQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.some((p) => p.content.type === "file"),
  });
  const createEntities = useCreateEntities();
  const t = useTranslations();

  if (isEntitiesLimitReached) {
    return null;
  }

  const isUploadDisabled = isWorkflowRunning || isUploadPending;
  const isCreationDisabled = isWorkflowRunning || createEntities.isPending;

  const handleCreateEntity = (kind: EntityKind) => {
    createEntities.mutate(
      {
        workspaceId,
        type: "manual-input",
        kind,
        parentId: parentId ?? undefined,
        name: kind === "folder" ? t("workspaces.newFolder") : undefined,
      },
      {
        onSuccess: (data) => {
          toastManager.add({
            title:
              kind === "folder"
                ? t("success.folderCreated")
                : t("success.documentCreated"),
            type: "success",
          });
          if (kind === "folder" && data?.entityId) {
            onFolderCreated?.(data.entityId);
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

  const handleCreateTask = async () => {
    const response = await api.tasks({ workspaceId }).put({
      queryKey: entitiesKeys.all(workspaceId),
      name: t("tasks.untitled"),
    });

    const entityId = response.data?.entityId;
    if (response.error || !entityId) {
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    toastManager.add({
      title: t("success.taskCreated"),
      type: "success",
    });
    useInspectorStore.getState().openTask(entityId, "", true);
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            render ?? (
              <Button size="xs" variant="ghost">
                <PlusIcon />
                {t("common.add")}
              </Button>
            )
          }
        />

        <MenuPopup>
          {hasFileProperties && (
            <>
              <MenuItem
                disabled={isUploadDisabled}
                onClick={() => {
                  fileInputRef.current?.click();
                }}
              >
                <UploadIcon />
                {t("common.uploadFiles")}
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuItem
            disabled={isCreationDisabled}
            onClick={() => handleCreateEntity("document")}
          >
            <FileTextIcon />
            {t("workspaces.newDocument")}
          </MenuItem>
          <MenuItem
            disabled={isCreationDisabled}
            onClick={() => {
              handleCreateTask().catch(() => {
                // Error handled inside handleCreateTask
              });
            }}
          >
            <SquareCheckIcon />
            {t("tasks.newTask")}
          </MenuItem>
          <MenuItem
            disabled={isCreationDisabled}
            onClick={() => handleCreateEntity("folder")}
          >
            <FolderPlusIcon />
            {t("workspaces.newFolder")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {hasFileProperties && (
        <input
          className="sr-only"
          multiple
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            if (files.length > 0) {
              createFileEntities(files);
            }
            e.target.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />
      )}
    </>
  );
};
