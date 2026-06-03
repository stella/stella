import { FilterIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import { ClientFilterPopover } from "@/routes/_protected.workspaces/-filters/client-filter-popover";
import { DateFilterPopover } from "@/routes/_protected.workspaces/-filters/date-filter-popover";
import { ItemsFilterPopover } from "@/routes/_protected.workspaces/-filters/items-filter-popover";
import { TeamFilterPopover } from "@/routes/_protected.workspaces/-filters/team-filter-popover";
import type {
  DateFilter,
  FilterableColumnId,
  LeadFilter,
  NumericFilter,
  Workspace,
} from "@/routes/_protected.workspaces/-types";
import { useConfigStore } from "@/stores/config-store";

type ColumnFilterButtonProps = {
  columnId: FilterableColumnId;
  workspaces: readonly Workspace[];
};

export const ColumnFilterButton = ({
  columnId,
  workspaces,
}: ColumnFilterButtonProps) => {
  const t = useTranslations();
  const filters = useConfigStore((s) => s.matters.filters);
  const setFilter = useConfigStore((s) => s.setMattersFilter);
  const clearFilter = useConfigStore((s) => s.clearMattersFilter);

  const setOrClear = <K extends keyof typeof filters>(
    key: K,
    value: (typeof filters)[K] | undefined,
  ) => {
    if (value === undefined) {
      clearFilter(key);
    } else {
      setFilter(key, value);
    }
  };

  const isActive = (() => {
    switch (columnId) {
      case "client":
        return !!filters.client?.length;
      case "team":
        return !!filters.team?.length || filters.lead !== undefined;
      case "entityCount":
        return filters.entityCount !== undefined;
      case "lastActivityAt":
        return filters.lastActivityAt !== undefined;
      case "createdAt":
        return filters.createdAt !== undefined;
    }
  })();

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label={t("workspaces.filters.openFilter")}
            className={cn(
              "inline-flex size-4 cursor-pointer items-center justify-center rounded-sm opacity-0 transition-opacity",
              "group-hover/header:opacity-100 focus-visible:opacity-100",
              isActive && "text-primary hover:text-primary/80 opacity-100",
            )}
            type="button"
          />
        }
      >
        <FilterIcon
          className={cn("size-3", isActive && "fill-primary stroke-primary")}
        />
      </PopoverTrigger>
      <PopoverPopup align="start">
        {columnId === "client" && (
          <ClientFilterPopover
            onChange={(v) => setOrClear("client", v)}
            value={filters.client}
            workspaces={workspaces}
          />
        )}
        {columnId === "team" && (
          <TeamFilterPopover
            leadValue={filters.lead}
            onLeadChange={(v: LeadFilter | undefined) => setOrClear("lead", v)}
            onTeamChange={(v) => setOrClear("team", v)}
            teamValue={filters.team}
            workspaces={workspaces}
          />
        )}
        {columnId === "entityCount" && (
          <ItemsFilterPopover
            onChange={(v: NumericFilter | undefined) =>
              setOrClear("entityCount", v)
            }
            value={filters.entityCount}
          />
        )}
        {columnId === "lastActivityAt" && (
          <DateFilterPopover
            onChange={(v: DateFilter | undefined) =>
              setOrClear("lastActivityAt", v)
            }
            value={filters.lastActivityAt}
          />
        )}
        {columnId === "createdAt" && (
          <DateFilterPopover
            onChange={(v: DateFilter | undefined) => setOrClear("createdAt", v)}
            value={filters.createdAt}
          />
        )}
      </PopoverPopup>
    </Popover>
  );
};
