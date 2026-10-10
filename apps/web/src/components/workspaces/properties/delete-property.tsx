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
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { Trash2Icon } from "@stll/ui/icons";

import { WorkflowQueryFeedback } from "@/components/workspaces/workflow-query-feedback";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { WorkspaceProperty } from "@/lib/types";
import { useDeleteProperty } from "@/lib/workspaces/mutations/properties";
import { useIsWorkflowRunning } from "@/lib/workspaces/queries/workspace";
import { workflowActionsDisabled } from "@/lib/workspaces/queries/workspace.logic";

type DeletePropertyProps = {
  workspaceId: string;
  property: WorkspaceProperty;
};
export const DeleteProperty = ({
  workspaceId,
  property,
}: DeletePropertyProps) => {
  const t = useTranslations();
  const workflowView = useIsWorkflowRunning(workspaceId);
  const workflowDisabled = workflowActionsDisabled(workflowView);
  const deleteProperty = useDeleteProperty();
  const canDelete = property.content.type !== "file";

  return (
    <>
      <WorkflowQueryFeedback view={workflowView} />
      <AlertDialog>
        <AlertDialogTrigger
          nativeButton
          render={
            <Button
              className="text-destructive-foreground justify-start font-normal"
              disabled={
                workflowDisabled || !canDelete || deleteProperty.isPending
              }
              size="sm"
              variant="ghost"
            />
          }
        >
          <Trash2Icon /> {t("workspaces.properties.deleteProperty")}
        </AlertDialogTrigger>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.properties.deleteProperty")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspaces.properties.deletePropertyConfirmDescription", {
                propertyName: property.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button
                  disabled={workflowDisabled || deleteProperty.isPending}
                  onClick={() => {
                    deleteProperty.mutate(
                      {
                        workspaceId,
                        propertyId: property.id,
                      },
                      {
                        onError: (error) => {
                          notifyUserError(error, t("errors.actionFailed"));
                        },
                      },
                    );
                  }}
                  variant="destructive"
                />
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
