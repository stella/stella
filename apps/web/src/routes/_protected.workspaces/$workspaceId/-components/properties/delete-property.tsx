import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import { toastManager } from "@stll/ui/components/toast";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { WorkspaceProperty } from "@/lib/types";
import { useDeleteProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

type DeletePropertyProps = {
  workspaceId: string;
  property: WorkspaceProperty;
};
export const DeleteProperty = ({
  workspaceId,
  property,
}: DeletePropertyProps) => {
  const t = useTranslations();
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const deleteProperty = useDeleteProperty();
  // TODO: add ability to create file properties
  // const { data: canDelete } = useSuspenseQuery({
  //   ...propertiesOptions(workspaceId),
  //   select: (data) => data.filter((p) => p.content.type === "file").length >= 1,
  // });
  const canDelete = property.content.type !== "file";

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            className="text-destructive-foreground justify-start font-semibold"
            disabled={
              isWorkflowRunning || !canDelete || deleteProperty.isPending
            }
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
                onClick={() => {
                  deleteProperty.mutate(
                    {
                      workspaceId,
                      propertyId: property.id,
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
  );
};
