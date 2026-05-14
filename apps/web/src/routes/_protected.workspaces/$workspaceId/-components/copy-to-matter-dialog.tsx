import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Label } from "@stll/ui/components/label";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import {
  entitiesKeys,
  workspaceFoldersOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import type { WorkspaceFolder } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

const routeApi = getRouteApi("/_protected");

type CopyToMatterDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceWorkspaceId: string;
  entityId: string;
  entityName: string;
};

type MoveMode = "copy" | "move";

export const CopyToMatterDialog = ({
  open,
  onOpenChange,
  sourceWorkspaceId,
  entityId,
  entityName,
}: CopyToMatterDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = routeApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [mode, setMode] = useState<MoveMode>("copy");
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(
    null,
  );
  const [targetParentId, setTargetParentId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data } = useQuery(workspacesOptions(activeOrganizationId));

  // Exclude current workspace from target options
  const targetWorkspaces =
    data?.workspaces.filter((w) => w.id !== sourceWorkspaceId) ?? [];

  const handleSubmit = async () => {
    if (!targetWorkspaceId) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(sourceWorkspaceId) })
        ["copy-to-workspace"].post({
          queryKey: entitiesKeys.all(sourceWorkspaceId),
          entityId: toSafeId<"entity">(entityId),
          targetWorkspaceId: toSafeId<"workspace">(targetWorkspaceId),
          targetParentId: targetParentId
            ? toSafeId<"entity">(targetParentId)
            : null,
          deleteSource: mode === "move",
        });

      if (response.error) {
        const errorMessage =
          typeof response.error.value === "object" &&
          response.error.value !== null &&
          "message" in response.error.value
            ? response.error.value.message
            : t("errors.actionFailed");
        stellaToast.add({
          title: t("errors.actionFailed"),
          description: errorMessage,
          type: "error",
        });
        return;
      }

      stellaToast.add({
        title:
          mode === "copy"
            ? t("workspaces.copyToMatter.copied")
            : t("workspaces.copyToMatter.moved"),
        type: "success",
      });

      // Invalidate both workspaces
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(sourceWorkspaceId),
      });
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(targetWorkspaceId),
      });

      onOpenChange(false);
    } catch {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setTargetWorkspaceId(null);
    setTargetParentId(null);
    setMode("copy");
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspaces.copyToMatter.title")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.copyToMatter.description", { name: entityName })}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {/* Copy/Move toggle */}
          <div className="space-y-2">
            <Label>{t("workspaces.copyToMatter.operation")}</Label>
            <div className="flex gap-2">
              <Button
                onClick={() => setMode("copy")}
                size="sm"
                variant={mode === "copy" ? "default" : "outline"}
              >
                {t("workspaces.copyToMatter.copyOption")}
              </Button>
              <Button
                onClick={() => setMode("move")}
                size="sm"
                variant={mode === "move" ? "default" : "outline"}
              >
                {t("workspaces.copyToMatter.moveOption")}
              </Button>
            </div>
          </div>

          {/* Target workspace selection */}
          <div className="space-y-2">
            <Label>{t("workspaces.copyToMatter.targetMatter")}</Label>
            <ScrollArea className="border-border h-48 rounded-md border">
              <div className="p-1">
                {targetWorkspaces.length === 0 ? (
                  <p className="text-muted-foreground p-2 text-sm">
                    {t("workspaces.copyToMatter.noOtherMatters")}
                  </p>
                ) : (
                  targetWorkspaces.map((workspace) => (
                    <button
                      className={cn(
                        "hover:bg-accent w-full rounded px-2 py-1.5 text-start text-sm",
                        targetWorkspaceId === workspace.id && "bg-accent",
                      )}
                      key={workspace.id}
                      onClick={() => {
                        setTargetWorkspaceId(workspace.id);
                        setTargetParentId(null);
                      }}
                      type="button"
                    >
                      {workspace.name}
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Target folder selection (optional) */}
          {targetWorkspaceId && (
            <div className="space-y-2">
              <Label>{t("workspaces.copyToMatter.targetFolder")}</Label>
              <FolderPicker
                onSelect={setTargetParentId}
                selectedFolderId={targetParentId}
                workspaceId={targetWorkspaceId}
              />
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button onClick={handleClose} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!targetWorkspaceId || isSubmitting}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {isSubmitting
              ? t("common.loading")
              : mode === "copy"
                ? t("common.copy")
                : t("workspaces.copyToMatter.moveButton")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type FolderPickerProps = {
  workspaceId: string;
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
};

const FolderPicker = ({
  workspaceId,
  selectedFolderId,
  onSelect,
}: FolderPickerProps) => {
  const t = useTranslations();
  const { data: folders, isLoading } = useQuery(
    workspaceFoldersOptions(workspaceId),
  );

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );

  if (isLoading) {
    return (
      <div className="border-border h-32 rounded-md border p-2">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  const rootFolders = folders?.filter((f) => f.parentId === null) ?? [];

  const toggleExpand = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const renderFolder = (folder: WorkspaceFolder, depth: number) => {
    const children = folders?.filter((f) => f.parentId === folder.entityId);
    const hasChildren = children && children.length > 0;
    const isExpanded = expandedFolders.has(folder.entityId);
    const isSelected = selectedFolderId === folder.entityId;

    return (
      <div key={folder.entityId}>
        <button
          className={cn(
            "hover:bg-accent flex w-full items-center gap-1 rounded px-2 py-1 text-start text-sm",
            isSelected && "bg-accent",
          )}
          onClick={() => onSelect(folder.entityId)}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          type="button"
        >
          {hasChildren ? (
            <button
              className="hover:bg-muted rounded p-0.5"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.entityId);
              }}
              type="button"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3 transition-transform",
                  isExpanded && "rotate-90",
                )}
              />
            </button>
          ) : (
            <span className="w-4" />
          )}
          <FolderIcon className="size-4" />
          <span className="truncate">{folder.name}</span>
        </button>
        {hasChildren && isExpanded && (
          <div>{children.map((child) => renderFolder(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <ScrollArea className="border-border h-32 rounded-md border">
      <div className="p-1">
        <button
          className={cn(
            "hover:bg-accent flex w-full items-center gap-1 rounded px-2 py-1 text-start text-sm",
            selectedFolderId === null && "bg-accent",
          )}
          onClick={() => onSelect(null)}
          type="button"
        >
          <span className="text-muted-foreground">
            {t("workspaces.copyToMatter.rootFolder")}
          </span>
        </button>
        {rootFolders.map((folder) => renderFolder(folder, 0))}
      </div>
    </ScrollArea>
  );
};
