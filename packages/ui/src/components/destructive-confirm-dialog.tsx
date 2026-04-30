"use client";

import type * as React from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPanel,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  DestructiveActionConfirmation,
  useDestructiveActionConfirmation,
} from "@stll/ui/components/destructive-action-confirmation";

type DestructiveConfirmDialogProps = {
  cancelLabel: React.ReactNode;
  confirmLabel: React.ReactNode;
  confirmation: string;
  description: React.ReactNode;
  inputLabel: React.ReactNode;
  loading?: boolean | undefined;
  onConfirm: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: React.ReactNode;
};

function DestructiveConfirmDialog({
  cancelLabel,
  confirmLabel,
  confirmation,
  description,
  inputLabel,
  loading = false,
  onConfirm,
  onOpenChange,
  open,
  title,
}: DestructiveConfirmDialogProps) {
  const typedConfirmation = useDestructiveActionConfirmation(confirmation);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      typedConfirmation.reset();
    }
  };

  const handleConfirm = async () => {
    if (!typedConfirmation.confirmed) {
      return;
    }

    try {
      await onConfirm();
      handleOpenChange(false);
    } catch {
      // Callers surface mutation errors; keep the dialog open for retry.
    }
  };

  return (
    <AlertDialog onOpenChange={handleOpenChange} open={open}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogPanel>
          <DestructiveActionConfirmation
            confirmation={confirmation}
            label={inputLabel}
            onValueChange={typedConfirmation.onValueChange}
            placeholder={confirmation}
            value={typedConfirmation.value}
          />
        </AlertDialogPanel>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {cancelLabel}
          </AlertDialogClose>
          <Button
            disabled={!typedConfirmation.confirmed}
            loading={loading}
            onClick={() => {
              // eslint-disable-next-line typescript/no-floating-promises
              handleConfirm();
            }}
            variant="destructive"
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export { DestructiveConfirmDialog };
export type { DestructiveConfirmDialogProps };
