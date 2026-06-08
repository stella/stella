import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import type { TableColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

export type SortHint = "text" | "date" | "number";

type SortPropertyProps = {
  column: TableColumn;
  sortHint?: SortHint | undefined;
};

const LABELS = {
  text: { asc: "A → Z", desc: "Z → A" },
  number: { asc: "1 → 9", desc: "9 → 1" },
  // Date labels are filled in at render time from i18n.
  date: { asc: "", desc: "" },
} as const satisfies Record<SortHint, { asc: string; desc: string }>;

export const SortProperty = ({ column, sortHint }: SortPropertyProps) => {
  const t = useTranslations("workspaces.properties");
  const disabled = !column.getCanSort();

  let ascLabel: string;
  let descLabel: string;

  if (!sortHint) {
    ascLabel = t("sortAscending");
    descLabel = t("sortDescending");
  } else if (sortHint === "date") {
    ascLabel = t("sortAscendingDate");
    descLabel = t("sortDescendingDate");
  } else {
    ascLabel = LABELS[sortHint].asc;
    descLabel = LABELS[sortHint].desc;
  }

  return (
    <div className="flex flex-col p-1">
      <Button
        className="justify-start font-normal"
        size="sm"
        disabled={disabled}
        onClick={() => {
          column.toggleSorting(false, false);
        }}
        variant="ghost"
      >
        <ArrowUpIcon /> {ascLabel}
      </Button>
      <Button
        className="justify-start font-normal"
        size="sm"
        disabled={disabled}
        onClick={() => {
          column.toggleSorting(true, false);
        }}
        variant="ghost"
      >
        <ArrowDownIcon /> {descLabel}
      </Button>
    </div>
  );
};

/** Map a property content type to a sort hint. */
export const toSortHint = (contentType: string): SortHint => {
  switch (contentType) {
    case "date":
      return "date";
    case "int":
      return "number";
    default:
      return "text";
  }
};
