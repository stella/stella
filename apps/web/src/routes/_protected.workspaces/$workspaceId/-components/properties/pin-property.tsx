import type { Column } from "@tanstack/react-table";
import { PinIcon, PinOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import type { WorkspaceEntity } from "@/lib/types";

type PinPropertyProps = {
  column: Column<WorkspaceEntity, unknown>;
};

export const PinProperty = ({ column }: PinPropertyProps) => {
  const t = useTranslations();

  if (!column.getCanPin()) {
    return null;
  }

  if (column.getIsPinned()) {
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
