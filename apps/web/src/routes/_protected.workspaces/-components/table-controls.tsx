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

import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useDeleteEntities } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

type TableControlsProps = {
  workspaceId: string;
  viewId: string;
};

export const TableControls = ({ workspaceId, viewId }: TableControlsProps) => (
  <DeleteEntitiesButton viewId={viewId} workspaceId={workspaceId} />
);

type DeleteEntitiesButtonProps = {
  workspaceId: string;
  viewId: string;
};

const DeleteEntitiesButton = ({
  workspaceId,
  viewId,
}: DeleteEntitiesButtonProps) => {
  const t = useTranslations();
  const rowSelection = useTableStore((s) => s.rowSelection[viewId]) ?? {};
  const setRowSelection = useTableStore((s) => s.setRowSelection);
  const isWorkflowRunning = useIsWorkflowRunning();
  const deleteEntities = useDeleteEntities();

  const handleDeleteEntities = () => {
    if (deleteEntities.isPending) {
      return;
    }

    const entityIds = Object.keys(rowSelection);

    deleteEntities.mutate(
      {
        workspaceId,
        entityIds,
      },
      {
        onSuccess: () => {
          setRowSelection(viewId, {});
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
