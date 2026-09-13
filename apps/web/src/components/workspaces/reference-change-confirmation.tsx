import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

type ReferenceChangeConfirmationProps = {
  newReference: string;
  oldReference: string;
  stampedVersionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
};

export const ReferenceChangeConfirmation = ({
  newReference,
  oldReference,
  stampedVersionCount,
  onCancel,
  onConfirm,
}: ReferenceChangeConfirmationProps) => {
  const t = useTranslations();

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("workspaces.referenceChangeConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t.rich("workspaces.referenceChangeConfirmDescription", {
              bdi: (chunks: ReactNode) => <BidiText>{chunks}</BidiText>,
              count: stampedVersionCount,
              newReference,
              oldReference,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={onCancel} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("common.confirm")}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
