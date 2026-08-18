import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@stll/ui/components/dialog";

import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";

type RunSizeConfirmDialogProps = {
  detail: RunSizeConfirmationDetail | null;
  /** Copy for the run kind (a review, a flow), already translated. */
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
};

/** Asks for an explicit go-ahead on a queued run whose estimated size
 *  crossed the confirmation threshold; closing without confirming
 *  abandons the parked request. */
export const RunSizeConfirmDialog = ({
  detail,
  title,
  confirmLabel,
  onConfirm,
  onDismiss,
}: RunSizeConfirmDialogProps) => {
  const t = useTranslations();
  return (
    <Dialog
      open={detail !== null}
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("common.runSizeConfirmDescription", {
              estimated: detail?.estimatedUnits ?? 0,
              available: detail?.availableUnits ?? 0,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
