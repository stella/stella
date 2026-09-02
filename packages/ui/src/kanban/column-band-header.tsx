import type { ReactNode } from "react";

import { ChevronDownIcon } from "lucide-react";

import { DirectionalIcon } from "../components/directional-icon";
import { cn } from "../lib/utils";

export type KanbanColumnBandHeaderProps = {
  /** The band name, or the control that has taken its place. */
  title: ReactNode;
  /** Colour swatch for the band. */
  swatch?: ReactNode;
  /** Short text after the name, such as the band's card count. */
  meta?: ReactNode;
  /** Whether the band's columns are shown; drives the toggle and its icon. */
  collapsed: boolean;
  /** Accessible name for the toggle, such as "Collapse To do". */
  toggleLabel: string;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Band menu or other controls, after the toggle. */
  actions?: ReactNode;
};

/**
 * The band header row above a run of columns: the same rhythm as
 * `KanbanColumnHeader` (swatch, name, count, controls), plus the collapse
 * toggle that folds the run into one narrow lane. Collapsed, the header is
 * the only thing left of the band, so it also carries the band's identity on
 * `aria-expanded` for the columns it hides.
 */
export const KanbanColumnBandHeader = ({
  title,
  swatch,
  meta,
  collapsed,
  toggleLabel,
  onCollapsedChange,
  actions,
}: KanbanColumnBandHeaderProps) => (
  <div
    className={cn(
      "flex items-center gap-2 py-2",
      collapsed ? "flex-col px-1" : "px-3",
    )}
    data-collapsed={collapsed ? "" : undefined}
    data-slot="kanban-column-band-header"
  >
    <button
      aria-expanded={!collapsed}
      aria-label={toggleLabel}
      className="hover:bg-muted/60 text-muted-foreground hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-md transition-[background-color]"
      onClick={() => onCollapsedChange(!collapsed)}
      type="button"
    >
      <DirectionalIcon
        className={cn("size-4 transition-transform", collapsed && "-rotate-90")}
        flip={collapsed}
        icon={ChevronDownIcon}
      />
    </button>
    {swatch}
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-sm font-medium",
        collapsed ? "rotate-180 [writing-mode:vertical-rl]" : "flex-1 truncate",
      )}
    >
      {title}
      {meta !== undefined && (
        <span className="text-muted-foreground text-xs tabular-nums">
          {meta}
        </span>
      )}
    </span>
    {collapsed ? null : actions}
  </div>
);
