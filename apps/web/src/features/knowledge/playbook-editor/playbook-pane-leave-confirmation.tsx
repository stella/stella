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

import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { detached } from "@/lib/detached";

import {
  cancelPlaybookPaneLeave,
  confirmPlaybookPaneLeave,
  usePlaybookPaneLeave,
  usePlaybookPaneHasUnsavedWork,
} from "./playbook-pane-parking";

export const PlaybookPaneLeaveConfirmation = () => {
  const t = useTranslations();
  const request = usePlaybookPaneLeave();
  const isDirty = usePlaybookPaneHasUnsavedWork();
  useUnsavedWork({ surface: "playbook-editor", guard: "unload", isDirty });
  const failed =
    request.type === "confirm" && request.leaveState === "save-failed";
  const saving = request.type === "confirm" && request.phase === "saving";
  const retryUnavailable = failed && request.saveBeforeLeave === null;
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
            {t(
              failed
                ? "knowledge.playbooks.saveFailed"
                : "common.unsavedLeaveConfirm",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("common.goBackToEditing")}
          </AlertDialogClose>
          <Button
            disabled={saving || retryUnavailable}
            onClick={() =>
              detached(
                confirmPlaybookPaneLeave(),
                "playbook-pane.confirm-leave",
              )
            }
          >
            {t(failed ? "common.save" : "clauses.leaveAndDiscard")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
