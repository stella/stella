import React, { useRef } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { toastManager } from "@stll/ui/components/toast";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  FolderPlusIcon,
  PlusIcon,
  SquareCheckIcon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useEntitiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useCreateEntities } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

type VirtualAnchor = {
  getBoundingClientRect: () => DOMRect;
};

type AddEntityMenuProps = {
  workspaceId: string;
  parentId?: string | null | undefined;
  render?: React.ReactElement | undefined;
  onFolderCreated?: ((entityId: string) => void) | undefined;
  /** Controlled open state (for context menus). */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Virtual anchor for positioning (right-click). */
  anchor?: VirtualAnchor | null | undefined;
  /**
   * Whether to surface "New task" in the menu. Defaults to true.
   * Set to false on surfaces that don't show tasks by default
   * (e.g. the Files filesystem tree) so the menu doesn't offer an
   * action whose result the user can't see in place.
   */
  showTaskOption?: boolean | undefined;
  /**
   * Skip the menu entirely: clicking the trigger opens the file
   * picker. Used by the table's bottom-row "+" so a single click
   * goes straight to upload without intermediate New-task / New-
   * folder choices the user doesn't want here.
   */
  uploadOnly?: boolean | undefined;
};

export const AddEntityMenu = ({
  workspaceId,
  parentId,
  render,
  onFolderCreated,
  open,
  onOpenChange,
  anchor,
  showTaskOption = true,
  uploadOnly = false,
}: AddEntityMenuProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const isEntitiesLimitReached = useEntitiesCountLimit(workspaceId);
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

  const handleCreateFolder = () => {
    createEntities.mutate(
      {
        workspaceId,
        type: "manual-input",
        kind: "folder",
        ...(parentId && { parentId }),
        name: t("workspaces.newFolder"),
      },
      {
        onSuccess: (data) => {
          toastManager.add({
            title: t("success.folderCreated"),
            type: "success",
          });
          if (data?.entityId !== undefined) {
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

  const handleUploadClick = () => {
    if (isUploadDisabled) {
      return;
    }
    fileInputRef.current?.click();
  };

  if (uploadOnly && hasFileProperties) {
    const trigger = render ?? (
      <Button size="xs" variant="ghost">
        <PlusIcon />
        {t("common.uploadFiles")}
      </Button>
    );
    return (
      <>
        {React.cloneElement(trigger, { onClick: handleUploadClick })}
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
      </>
    );
  }

  return (
    <>
      <Menu onOpenChange={onOpenChange} open={open}>
        <MenuTrigger
          nativeButton
          render={
            render ?? (
              <Button size="xs" variant="ghost">
                <PlusIcon />
                {t("common.add")}
              </Button>
            )
          }
        />

        <MenuPopup anchor={anchor ?? undefined}>
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
          {showTaskOption && (
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
          )}
          <MenuItem disabled={isCreationDisabled} onClick={handleCreateFolder}>
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
