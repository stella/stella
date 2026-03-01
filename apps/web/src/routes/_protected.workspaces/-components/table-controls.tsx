import { useSearch } from "@tanstack/react-router";
import { TrashIcon } from "lucide-react";
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
import { Separator } from "@stella/ui/components/separator";
import { toastManager } from "@stella/ui/components/toast";

import { useDeleteEntities } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type TableControlsProps = {
  workspaceId: string;
};

export const TableControls = ({ workspaceId }: TableControlsProps) => {
  return <DeleteEntitiesButton workspaceId={workspaceId} />;
};

type DeleteEntitiesButtonProps = {
  workspaceId: string;
};

const DeleteEntitiesButton = ({ workspaceId }: DeleteEntitiesButtonProps) => {
  const t = useTranslations();
  const rowSelection = useSearch({
    from: "/_protected/workspaces/$workspaceId/",
    select: (s) => s.rowSelection,
  });
  const isWorkflowRunning = useIsWorkflowRunning();
  const deleteEntities = useDeleteEntities();

  const handleDeleteEntities = () => {
    if (deleteEntities.isPending) {
      return;
    }

    const store = useWorkspaceStore.getState();

    const entities = store.getEntities(rowSelection);

    deleteEntities.mutate(
      {
        workspaceId,
        entityIds: entities.map((entity) => entity.entityId),
      },
      {
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const selectedRowsCount = Object.keys(rowSelection).length;

  if (selectedRowsCount === 0) {
    return null;
  }

  return (
    <>
      <Separator className="mx-2 h-4" orientation="vertical" />
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              disabled={deleteEntities.isPending || isWorkflowRunning}
              size="sm"
              variant="destructive-outline"
            />
          }
        >
          <TrashIcon /> {t("workspaces.deleteSelection")}
        </AlertDialogTrigger>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.deleteSelectedRows")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspaces.deleteSelectedRowsDescription", {
                count: selectedRowsCount,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button onClick={handleDeleteEntities} variant="destructive" />
              }
            >
              {t("common.delete")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
