import type { ComponentType } from "react";

import { EyeOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";

import { PinProperty } from "@/components/workspaces/properties/pin-property";
import { SortProperty } from "@/components/workspaces/properties/sort-property";
import type { SortHint } from "@/components/workspaces/properties/sort-property";
import type {
  TableColumn,
  TableRowData,
  TableTreeNode,
} from "@/components/workspaces/table/types";

type MetadataPopoverProps<TRow extends TableRowData> = {
  column: TableColumn<TRow>;
  icon: ComponentType<{ className?: string }>;
  label: string;
  sortHint?: SortHint | undefined;
};

export const MetadataPopover = <TRow extends TableRowData = TableTreeNode>({
  column,
  icon: Icon,
  label,
  sortHint,
}: MetadataPopoverProps<TRow>) => {
  const t = useTranslations();

  return (
    <Popover modal>
      <PopoverTrigger
        render={
          <Button
            className="h-full w-full justify-start text-start"
            size="sm"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="w-0 flex-1 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="min-w-48 overflow-clip"
        initialFocus={false}
        padding="none"
      >
        <SortProperty column={column} sortHint={sortHint} />
        <Separator />
        <div className="flex flex-col p-1">
          <PinProperty column={column} />
          <Button
            className="justify-start font-normal"
            size="sm"
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
