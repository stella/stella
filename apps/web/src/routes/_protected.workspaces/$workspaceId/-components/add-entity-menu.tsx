import React, { useRef, useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  FolderPlusIcon,
  FilePlus2Icon,
  LayoutTemplateIcon,
  PlusIcon,
  SquareCheckIcon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";

import { StyleSetPickerDialog } from "@/features/style-sets/style-set-picker-dialog";
import type { StyleSelection } from "@/features/style-sets/style-set-picker-dialog";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { toSafeId } from "@/lib/safe-id";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { NewDocumentFromTemplateDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/new-document-from-template-dialog";
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
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const isEntitiesLimitReached = useEntitiesCountLimit(workspaceId);
  const [isUploadPending, createFileEntities] =
    useCreateFileEntities(workspaceId);
  const { data: hasFileProperties } = useSuspenseQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.some((p) => p.content.type === "file"),
  });
  const createEntities = useCreateEntities();
  const canUseTemplate = usePermissions({ template: ["use"] });
  const canCreateStyledDocument = usePermissions({
    entity: ["create"],
    styleSet: ["use"],
  });
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
          stellaToast.add({
            title: t("success.folderCreated"),
            type: "success",
          });
          onFolderCreated?.(data.entityId);
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

  const handleCreateTask = async () => {
    const response = await api.tasks({ workspaceId }).put({
      queryKey: entitiesKeys.all(workspaceId),
      name: t("tasks.untitled"),
    });

    const entityId = response.data?.entityId;
    if (response.error || !entityId) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    stellaToast.add({
      title: t("success.taskCreated"),
      type: "success",
    });
    useInspectorStore
      .getState()
      .openTask({ taskId: entityId, workspaceId, isNew: true });
  };

  const handleUploadClick = () => {
    if (isUploadDisabled) {
      return;
    }
    fileInputRef.current?.click();
  };

  const handleCreateDocument = async (
    name: string,
    style: StyleSelection,
  ): Promise<boolean> => {
    const input = {
      queryKey: entitiesKeys.all(workspaceId),
      name,
      parentId: parentId ? toSafeId<"entity">(parentId) : null,
    };
    const response =
      style.type === "stella"
        ? await api.entities({ workspaceId })["blank-document"].put(input)
        : await api
            .entities({ workspaceId })
            ["blank-document-from-style-set"].put({
              ...input,
              styleSetId: toSafeId<"styleSet">(style.styleSetId),
            });
    if (response.error) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return false;
    }

    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
    useInspectorStore.getState().openFile({
      id: response.data.fieldId,
      entityId: response.data.entityId,
      label: response.data.fileName,
      fileName: response.data.fileName,
      mimeType: DOCX_MIME,
      pdfFileId: null,
      workspaceId,
    });
    return true;
  };

  const fileInput = hasFileProperties ? (
    <input
      className="sr-only"
      multiple
      onChange={(e) => {
        const files = e.currentTarget.files ? [...e.currentTarget.files] : [];
        if (files.length > 0) {
          createFileEntities({ files, parentId: parentId ?? null });
        }
        e.target.value = "";
      }}
      ref={fileInputRef}
      type="file"
    />
  ) : null;

  if (uploadOnly && hasFileProperties) {
    const trigger = render ?? (
      <Button size="xs" variant="ghost">
        <PlusIcon />
        {t("common.uploadFiles")}
      </Button>
    );
    return (
      <>
        {/* eslint-disable-next-line react/react-compiler, react/no-clone-element -- handleUploadClick reads fileInputRef only inside the click handler; cloneElement obscures the call graph so the compiler conservatively flags a render-time ref access. cloneElement is required here to attach the click handler onto the caller-supplied `render` trigger element without knowing its concrete type. */}
        {React.cloneElement(trigger, { onClick: handleUploadClick })}
        {fileInput}
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
              <MenuItem disabled={isUploadDisabled} onClick={handleUploadClick}>
                <UploadIcon />
                {t("common.uploadFiles")}
              </MenuItem>
              {canCreateStyledDocument && (
                <MenuItem
                  disabled={isWorkflowRunning}
                  onClick={() => setStyleDialogOpen(true)}
                >
                  <FilePlus2Icon />
                  {t("styleSets.newDocument")}
                </MenuItem>
              )}
              {canUseTemplate && (
                <MenuItem
                  disabled={isWorkflowRunning}
                  onClick={() => setTemplateDialogOpen(true)}
                >
                  <LayoutTemplateIcon />
                  {t("templates.newFromTemplate")}
                </MenuItem>
              )}
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
      {fileInput}
      {canUseTemplate && (
        <NewDocumentFromTemplateDialog
          onOpenChange={setTemplateDialogOpen}
          open={templateDialogOpen}
          parentId={parentId}
          workspaceId={workspaceId}
        />
      )}
      {canCreateStyledDocument && (
        <StyleSetPickerDialog
          initialName={t("styleSets.untitledDocument")}
          onCreate={handleCreateDocument}
          onOpenChange={setStyleDialogOpen}
          open={styleDialogOpen}
          title={t("styleSets.newDocument")}
        />
      )}
    </>
  );
};
