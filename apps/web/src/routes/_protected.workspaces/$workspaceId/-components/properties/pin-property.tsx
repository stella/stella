import { PinIcon, PinOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import type { TableColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

type PinPropertyProps = {
  column: TableColumn;
};

export const PinProperty = ({ column }: PinPropertyProps) => {
  const t = useTranslations();

  if (!column.getCanPin()) {
    return null;
  }

  const isPinned = column.getIsPinned() !== false;
  const togglePinned = () => {
    column.pin(isPinned ? false : "left");
  };

  if (isPinned) {
    return (
      <Button
        className="justify-start font-normal"
        size="sm"
        onClick={togglePinned}
        variant="ghost"
      >
        <PinOffIcon /> {t("common.unpin")}
      </Button>
    );
  }

  return (
    <Button
      className="justify-start font-semibold"
      onClick={togglePinned}
      variant="ghost"
    >
      <PinIcon /> {t("common.pin")}
    </Button>
  );
};
