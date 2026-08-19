import { useSelector } from "@tanstack/react-store";
import type { ColumnPinningState } from "@tanstack/react-table";
import { PinIcon, PinOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { TableColumn } from "@/components/workspaces/table/types";

type PinPropertyProps = {
  column: TableColumn;
};

const isColumnPinned = (pinning: ColumnPinningState, columnId: string) =>
  pinning.start.includes(columnId) || pinning.end.includes(columnId);

export const PinProperty = ({ column }: PinPropertyProps) => {
  const t = useTranslations();
  // Subscribe to the pinning slice instead of calling `column.getIsPinned()`.
  // Column objects are memoized on `options.columns`, so their identity does
  // not change when pinning does; React Compiler caches a plain getter read
  // against that identity, leaving the label at whatever it was when this
  // popover first mounted. The store subscription also re-renders the button
  // when an ancestor reuses its own memoized output.
  const isPinned = useSelector(column.table.store, (state) =>
    isColumnPinned(state.columnPinning, column.id),
  );

  if (!column.getCanPin()) {
    return null;
  }

  const togglePinned = () => {
    column.pin(isPinned ? false : "start");
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
      className="justify-start font-normal"
      size="sm"
      onClick={togglePinned}
      variant="ghost"
    >
      <PinIcon /> {t("common.pin")}
    </Button>
  );
};
