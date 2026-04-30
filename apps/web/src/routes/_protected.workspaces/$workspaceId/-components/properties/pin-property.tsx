import { Button } from "@stll/ui/components/button";
import { PinIcon, PinOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { TableColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

type PinPropertyProps = {
  column: TableColumn;
};

export const PinProperty = ({ column }: PinPropertyProps) => {
  const t = useTranslations();

  if (!column.getCanPin()) {
    return null;
  }

  if (column.getIsPinned() !== false) {
    return (
      <Button
        className="justify-start font-semibold"
        onClick={() => {
          column.pin(false);
        }}
        variant="ghost"
      >
        <PinOffIcon /> {t("common.unpin")}
      </Button>
    );
  }

  return (
    <Button
      className="justify-start font-semibold"
      onClick={() => {
        column.pin("left");
      }}
      variant="ghost"
    >
      <PinIcon /> {t("common.pin")}
    </Button>
  );
};
