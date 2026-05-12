import { useEffect, useState } from "react";

import { PinIcon, PinOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import type { TableColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

type PinPropertyProps = {
  column: TableColumn;
};

export const PinProperty = ({ column }: PinPropertyProps) => {
  const t = useTranslations();
  const pinnedState = column.getIsPinned() !== false;
  const [isPinned, setIsPinned] = useState(pinnedState);

  useEffect(() => {
    setIsPinned(pinnedState);
  }, [pinnedState]);

  if (!column.getCanPin()) {
    return null;
  }

  const togglePinned = () => {
    const nextPinned = !isPinned;
    setIsPinned(nextPinned);
    column.pin(nextPinned ? "left" : false);
  };

  if (isPinned) {
    return (
      <Button
        className="justify-start font-semibold"
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
