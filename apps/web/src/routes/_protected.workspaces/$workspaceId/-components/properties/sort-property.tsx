import type { Column } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import type { WorkspaceEntity } from "@/lib/types";

type SortPropertyProps = {
  column: Column<WorkspaceEntity, unknown>;
};

export const SortProperty = ({ column }: SortPropertyProps) => {
  const t = useTranslations();
  const disabled = !column.getCanSort();

  return (
    <div className="flex flex-col p-1">
      <Button
        className="justify-start font-semibold"
        disabled={disabled}
        onClick={() => {
          column.toggleSorting(false, false);
        }}
        variant="ghost"
      >
        <ArrowUpIcon /> {t("workspaces.properties.sortAscending")}
      </Button>
      <Button
        className="justify-start font-semibold"
        disabled={disabled}
        onClick={() => {
          column.toggleSorting(true, false);
        }}
        variant="ghost"
      >
        <ArrowDownIcon /> {t("workspaces.properties.sortDescending")}
      </Button>
    </div>
  );
};
