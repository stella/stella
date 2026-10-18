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
} from "./alert-dialog";
import { Button } from "./button";
import {
  DestructiveActionConfirmation,
  useDestructiveActionConfirmation,
} from "./destructive-action-confirmation";

/**
 * What a settled confirm asks of the dialog: `keep-open` when the action was
 * refused and the dialog shows why, so the caller need not throw to keep it.
 */
type DestructiveConfirmOutcome = "keep-open";

type DestructiveConfirmDialogProps = {
  cancelLabel: React.ReactNode;
  confirmLabel: React.ReactNode;
  confirmation: string;
  description: React.ReactNode;
  inputLabel: React.ReactNode;
  loading?: boolean | undefined;
  /** Settles to `"keep-open"` to keep the dialog; anything else closes it. */
  onConfirm: () => unknown;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: React.ReactNode;
};

const DestructiveConfirmDialog = ({
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
}: DestructiveConfirmDialogProps) => {
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
      const outcome: unknown = await onConfirm();
      if (outcome !== ("keep-open" satisfies DestructiveConfirmOutcome)) {
        handleOpenChange(false);
      }
    } catch {
      // Callers surface mutation errors; keep the dialog open for retry.
    }
  };

  const handleConfirmClick = () => {
    // `handleConfirm` settles a failed confirm itself, so a rejection here is
    // a bug. The platform error channel surfaces it while the design-system
    // layer stays free of an app-specific telemetry channel.
    handleConfirm().catch(reportError);
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
            onClick={handleConfirmClick}
            variant="destructive"
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};

export { DestructiveConfirmDialog };
export type { DestructiveConfirmDialogProps, DestructiveConfirmOutcome };
