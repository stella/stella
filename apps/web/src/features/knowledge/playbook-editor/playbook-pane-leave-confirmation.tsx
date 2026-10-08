import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";

import {
  cancelPlaybookPaneLeave,
  confirmPlaybookPaneLeave,
  usePlaybookPaneLeave,
} from "./playbook-pane-parking";

export const PlaybookPaneLeaveConfirmation = () => {
  const t = useTranslations();
  const request = usePlaybookPaneLeave();
  return (
    <AlertDialog
      open={request.type === "confirm"}
      onOpenChange={(open) => {
        if (!open) {
          cancelPlaybookPaneLeave();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("common.confirmAction")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("common.unsavedLeaveConfirm")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("common.goBackToEditing")}
          </AlertDialogClose>
          <Button onClick={confirmPlaybookPaneLeave}>
            {t("common.leaveAndDiscard")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
