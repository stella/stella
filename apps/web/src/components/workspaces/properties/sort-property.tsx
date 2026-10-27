import { useId } from "react";

import { useTranslations } from "use-intl";

import { SORT_DIRECTIONS } from "@stll/api-contract/column-sort";
import type {
  ColumnSortKind,
  SortDirection,
} from "@stll/api-contract/column-sort";
import { Button } from "@stll/ui/button";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon } from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";

import { SORT_DIRECTION_LABEL_KEYS } from "@/components/workspaces/properties/sort-property.logic";
import type { SortDirectionOffers } from "@/components/workspaces/properties/sort-property.logic";
import type {
  TableColumn,
  TableRowData,
  TableTreeNode,
} from "@/components/workspaces/table/types";

const DIRECTION_ICONS = {
  asc: ArrowUpIcon,
  desc: ArrowDownIcon,
} as const satisfies Record<SortDirection, LucideIcon>;

type SortPropertyProps<TRow extends TableRowData> = {
  column: TableColumn<TRow>;
  /** What the column's values are, which decides what each item says. */
  kind: ColumnSortKind;
  /** Which ways the rows may be ordered by this column right now. */
  directions: SortDirectionOffers;
};

export const SortProperty = <TRow extends TableRowData = TableTreeNode>({
  column,
  directions,
  kind,
}: SortPropertyProps<TRow>) => {
  const t = useTranslations();
  const reasonIdPrefix = useId();
  const canSort = column.getCanSort();
  const active = column.getIsSorted();

  return (
    <div className="flex flex-col p-1">
      {SORT_DIRECTIONS.map((direction) => {
        const Icon = DIRECTION_ICONS[direction];
        const availability = directions[direction];
        const isActive = active === direction;
        const reasonId = `${reasonIdPrefix}-${direction}`;
        return (
          <div className="flex flex-col" key={direction}>
            <Button
              aria-describedby={
                availability.type === "unavailable" ? reasonId : undefined
              }
              aria-pressed={isActive}
              className="justify-start font-normal"
              disabled={!canSort || availability.type === "unavailable"}
              onClick={() => {
                column.toggleSorting(direction === "desc", false);
              }}
              size="sm"
              variant="ghost"
            >
              <Icon />
              <span className="flex-1 text-start">
                {t(SORT_DIRECTION_LABEL_KEYS[kind][direction])}
              </span>
              {isActive && <CheckIcon aria-hidden />}
            </Button>
            {availability.type === "unavailable" && (
              <p
                className="text-muted-foreground max-w-56 px-2 pb-1 text-xs text-pretty"
                id={reasonId}
              >
                {availability.reason}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};
