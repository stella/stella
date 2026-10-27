import type { ComponentType } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { EyeOffIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";

import { PinProperty } from "@/components/workspaces/properties/pin-property";
import { SortProperty } from "@/components/workspaces/properties/sort-property";
import type { ColumnSortOffer } from "@/components/workspaces/properties/sort-property.logic";
import type {
  TableColumn,
  TableRowData,
  TableTreeNode,
} from "@/components/workspaces/table/types";

type MetadataPopoverProps<TRow extends TableRowData> = {
  column: TableColumn<TRow>;
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** What the sort items offer for this column, if it orders the rows at all. */
  sort: ColumnSortOffer;
};

export const MetadataPopover = <TRow extends TableRowData = TableTreeNode>({
  column,
  icon: Icon,
  label,
  sort,
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
        <ColumnSortItems column={column} sort={sort} />
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

const ColumnSortItems = <TRow extends TableRowData>({
  column,
  sort,
}: {
  column: TableColumn<TRow>;
  sort: ColumnSortOffer;
}) => {
  switch (sort.type) {
    case "unordered":
      return null;
    case "ordered":
      return (
        <>
          <SortProperty
            column={column}
            directions={sort.directions}
            kind={sort.kind}
          />
          <Separator />
        </>
      );
    default:
      sort satisfies never;
      return panic(`Unhandled column sort offer: ${String(sort)}`);
  }
};
