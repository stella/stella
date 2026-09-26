import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import type { KanbanGroup } from "@stll/ui/kanban";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { SelectColorIcon } from "@/components/workspaces/properties/shared";

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
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;

  return (
    <div
      className={cn(
        "sticky top-0 z-40 flex items-center gap-2 border-b pe-3",
        // An empty category recedes into the background, surfacing on hover
        // so it stays scannable without competing with populated groups.
        empty && "opacity-60 transition-opacity duration-200 hover:opacity-100",
      )}
      // Opaque header so scrolled rows don't show through. `bg-muted` and
      // `bg-secondary` are both translucent (~4% over transparent) in this theme,
      // so we composite that 4% tint over the opaque background by hand.
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--foreground) 4%, var(--background))",
      }}
    >
      {/* The whole header row is the toggle target, not just the chevron. */}
      <button
        aria-expanded={empty ? undefined : !collapsed}
        className={cn(
          "flex min-w-0 flex-1 items-center py-1.5 text-start",
          !empty && "hover:bg-foreground/[0.04]",
        )}
        disabled={empty}
        onClick={empty ? undefined : onToggle}
        type="button"
      >
        {/* The label stays pinned at the left while the band scrolls
            horizontally with the columns. The full-width `bg-muted` band lives
            on the row wrapper, so the pinned label adds no second layer (a
            second translucent `bg-muted` here darkened only the label's span,
            reading as a partial band that stopped mid-row). */}
        <span className="sticky start-0 flex items-center gap-2 ps-3">
          {empty ? (
            <span aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <DirectionalIcon
              icon={ChevronIcon}
              flip={collapsed}
              className="text-muted-foreground size-3.5 shrink-0"
            />
          )}
          {group.optionColor !== undefined && (
            <SelectColorIcon className="size-3.5" color={group.optionColor} />
          )}
          <span className="text-foreground text-sm font-medium">
            {group.label}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {loading ? (
              <Skeleton className="h-3 w-10" />
            ) : (
              t("workspaces.views.groupItemCount", { count })
            )}
          </span>
        </span>
      </button>
    </div>
  );
};
