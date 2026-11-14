import type { ReactElement } from "react";

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

/** A destructive billing action that asks before it runs. */
export const ConfirmAction = ({
  children,
  description,
  onConfirm,
}: {
  children: ReactElement;
  description: string;
  onConfirm: () => void;
}) => {
  const t = useTranslations("common");

  return (
    <AlertDialog>
      <AlertDialogTrigger nativeButton render={children} />
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmAction")}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("cancel")}
          </AlertDialogClose>
          <AlertDialogClose
            render={<Button onClick={onConfirm} variant="destructive" />}
          >
            {t("confirm")}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
