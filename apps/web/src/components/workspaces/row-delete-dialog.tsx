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

type RowDeleteDialogProps = {
  isBulk: boolean;
  name: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  selectedCount: number;
};

export const RowDeleteDialog = ({
  isBulk,
  name,
  onConfirm,
  onOpenChange,
  open,
  selectedCount,
}: RowDeleteDialogProps) => {
  const t = useTranslations();
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isBulk
              ? t("workspaces.deleteItems", { count: selectedCount })
              : t("workspaces.deleteItem")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isBulk
              ? t("workspaces.deleteItemsDescription", {
                  count: selectedCount,
                })
              : t("common.deleteConfirmDescription", { name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </AlertDialogClose>
          <AlertDialogClose
            render={<Button onClick={onConfirm} variant="destructive" />}
          >
            {t("common.delete")}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};
