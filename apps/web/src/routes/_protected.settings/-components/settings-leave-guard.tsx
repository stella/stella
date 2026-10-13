import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";

import type { useUnsavedWork } from "@/hooks/use-unsaved-work";

type LeaveGuardProps = {
  blocker: ReturnType<typeof useUnsavedWork>;
};

export const SettingsLeaveGuard = ({ blocker }: LeaveGuardProps) => {
  const common = useTranslations("common");
  return (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") {
          blocker.reset();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{common("confirmAction")}</AlertDialogTitle>
          <AlertDialogDescription>
            {common("unsavedLeaveConfirm")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {common("goBackToEditing")}
          </AlertDialogClose>
          <Button
            onClick={() => {
              if (blocker.status === "blocked") {
                blocker.proceed();
              }
            }}
          >
            {common("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
