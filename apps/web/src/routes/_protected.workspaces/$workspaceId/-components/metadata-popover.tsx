import type { Column } from "@tanstack/react-table";
import { EyeOffIcon, type LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { Separator } from "@stella/ui/components/separator";

import { PinProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/pin-property";
import {
  SortProperty,
  type SortHint,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";

type MetadataPopoverProps = {
  // Column operations (sort, pin) only need the column reference;
  // the row type is irrelevant here and varies between table
  // configurations.
  // biome-ignore lint/suspicious/noExplicitAny: row type varies across table configs
  column: Column<any, unknown>;
  icon: LucideIcon;
  label: string;
  sortHint?: SortHint;
  onHide?: () => void;
};

export const MetadataPopover = ({
  column,
  icon: Icon,
  label,
  sortHint,
  onHide,
}: MetadataPopoverProps) => {
  const t = useTranslations();

  return (
    <Popover modal>
      <PopoverTrigger className="flex h-full w-full items-center gap-1.5 pr-3 pl-2 text-start hover:bg-accent">
        <Icon className="size-3.5 shrink-0" />
        <span className="w-0 flex-1 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="min-w-48 overflow-clip *:data-[slot=popover-viewport]:p-0!"
        initialFocus={false}
      >
        <SortProperty column={column} sortHint={sortHint} />
        <Separator />
        <div className="flex flex-col p-1">
          <PinProperty column={column} />
          {onHide && (
            <Button
              className="justify-start font-semibold"
              onClick={onHide}
              variant="ghost"
            >
              <EyeOffIcon />
              {t("workspaces.kanban.hideColumn")}
            </Button>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
};
