import { useState, type ReactNode } from "react";

import { panic } from "better-result";
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

import type { CatalogueRemoval } from "./catalogue-removal.logic";
import { catalogueRemoval } from "./catalogue-removal.logic";
import type { CatalogueEntry } from "./catalogue-types";

type UseCatalogueRemovalOptions = {
  entry: CatalogueEntry;
  onRemove: () => void;
};

type CatalogueRemovalControls = {
  removal: CatalogueRemoval;
  /** What the Remove button calls: confirms first when the entry needs it. */
  requestRemoval: () => void;
  /** Render next to (not inside) the clickable surface the button sits in. */
  confirmDialog: ReactNode;
};

/**
 * The one path from a catalogue Remove button to the uninstall, shared by the
 * catalogue row and the detail panel so neither can skip the confirmation.
 */
export const useCatalogueRemoval = ({
  entry,
  onRemove,
}: UseCatalogueRemovalOptions): CatalogueRemovalControls => {
  const t = useTranslations();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const removal = catalogueRemoval(entry);

  const requestRemoval = () => {
    switch (removal) {
      case "none":
        return;
      case "immediate":
        onRemove();
        return;
      case "confirm":
        setConfirmOpen(true);
        return;
      default: {
        removal satisfies never;
        panic(`Unhandled catalogue removal: ${String(removal)}`);
      }
    }
  };

  const confirmDialog =
    removal === "confirm" ? (
      <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.remove")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("common.deleteConfirmDescription", {
                name: entry.displayName,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                onRemove();
              }}
              variant="destructive"
            >
              {t("common.remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    ) : null;

  return { removal, requestRemoval, confirmDialog };
};
