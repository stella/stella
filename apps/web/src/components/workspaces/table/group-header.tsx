import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import type { KanbanGroup } from "@stll/ui/kanban";

import { SelectColorIcon } from "@/components/workspaces/properties/shared";
import {
  TableGroupCountPending,
  TableGroupHeaderBand,
  TableGroupHeaderLine,
} from "@/components/workspaces/table/group-header.pending";

type GroupHeaderProps = {
  group: KanbanGroup;
  collapsed: boolean;
  empty: boolean;
  loading: boolean;
  onToggle: () => void;
  loadedCount: number;
  totalCount: number | null;
};

export const TableGroupHeader = ({
  group,
  collapsed,
  empty,
  loading,
  onToggle,
  loadedCount,
  totalCount,
}: GroupHeaderProps) => {
  const t = useTranslations();
  const count = totalCount ?? loadedCount;

  return (
    <TableGroupHeaderBand empty={empty}>
      {/* The whole header row is the toggle target, not just the chevron. */}
      <Button
        aria-expanded={empty ? undefined : !collapsed}
        className="flex min-w-0 flex-1"
        disabled={empty}
        onClick={empty ? undefined : onToggle}
        variant="plain"
      >
        <TableGroupHeaderLine
          collapsed={collapsed}
          colorIcon={
            group.optionColor !== undefined && (
              <SelectColorIcon className="size-3.5" color={group.optionColor} />
            )
          }
          tallySlot={
            loading ? (
              <TableGroupCountPending />
            ) : (
              t("workspaces.views.groupItemCount", { count })
            )
          }
          empty={empty}
          label={group.label}
        />
      </Button>
    </TableGroupHeaderBand>
  );
};
