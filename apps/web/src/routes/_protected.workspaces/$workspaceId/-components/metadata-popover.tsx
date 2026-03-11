import { EyeOffIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { Separator } from "@stella/ui/components/separator";

import { PinProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/pin-property";
import { SortProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";
import type { SortHint } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";
import type { TableColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

type MetadataPopoverProps = {
  column: TableColumn;
  icon: LucideIcon;
  label: string;
  sortHint?: SortHint;
};

export const MetadataPopover = ({
  column,
  icon: Icon,
  label,
  sortHint,
}: MetadataPopoverProps) => {
  const t = useTranslations();

  return (
    <Popover modal>
      <PopoverTrigger className="hover:bg-accent flex h-full w-full items-center gap-1.5 ps-2 pe-3 text-start">
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
          <Button
            className="justify-start font-semibold"
            onClick={() => column.toggleVisibility(false)}
            variant="ghost"
          >
            <EyeOffIcon />
            {t("workspaces.kanban.hideColumn")}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
};
