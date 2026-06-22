import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";

/** Confirmation shown when leaving a detail view with unsaved/un-versioned
 *  changes. The "keep editing" action cancels; the secondary and primary
 *  actions are caller-defined so templates (destructive "Discard changes" /
 *  "Save and leave") and clauses (neutral "Leave without a version" / "Save
 *  version & leave") can share the same shell with their own semantics. */
export const LeaveConfirmDialog = ({
  open,
  onOpenChange,
  description,
  cancelLabel,
  secondary,
  primary,
}: LeaveConfirmDialogProps) => {
  const t = useTranslations();

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("common.confirmAction")}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="justify-between sm:justify-between">
          <AlertDialogClose render={<Button variant="ghost" />}>
            <ArrowLeftIcon />
            {cancelLabel}
          </AlertDialogClose>
          <div className="flex items-center gap-2">
            <AlertDialogClose
              onClick={secondary.onClick}
              render={<Button variant={secondary.variant} />}
            >
              {secondary.label}
            </AlertDialogClose>
            <AlertDialogClose onClick={primary.onClick} render={<Button />}>
              {primary.label}
            </AlertDialogClose>
          </div>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};

type ButtonVariant = NonNullable<
  React.ComponentProps<typeof Button>["variant"]
>;

type LeaveConfirmAction = {
  label: string;
  onClick: () => void;
};

type LeaveConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  cancelLabel: string;
  secondary: LeaveConfirmAction & { variant: ButtonVariant };
  primary: LeaveConfirmAction;
};
