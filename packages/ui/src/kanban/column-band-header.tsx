import type { ReactNode } from "react";

import { ChevronDownIcon } from "lucide-react";

import { DirectionalIcon } from "../components/directional-icon";
import { cn } from "../lib/utils";
import { KANBAN_BAND_CAPTION_ROW_HEIGHT } from "./layout-tokens";

/**
 * How a band toggle was activated. A pointer activation leaves the pointer
 * over whatever replaces the caption (the folded slot), which matters to the
 * board's peek behaviour; a keyboard activation does not.
 */
export type KanbanBandToggleActivation = { viaPointer: boolean };

export type KanbanColumnBandHeaderProps = {
  /** The band name, or the control that has taken its place. */
  title: ReactNode;
  /** Colour swatch for the band. */
  swatch?: ReactNode;
  /** Short text after the name, such as the band's card count. */
  meta?: ReactNode;
  /** The band's persisted state; drives the toggle, its icon, and its label. */
  collapsed: boolean;
  /**
   * Render only the toggle, for the narrow slot of a folded band. Defaults to
   * `collapsed`; a board that peeks a collapsed band open passes `false` so
   * the caption shows the name while the toggle still offers to pin it open.
   */
  compact?: boolean | undefined;
  /** Accessible name for the toggle, such as "Collapse To do". */
  toggleLabel: string;
  onCollapsedChange: (
    collapsed: boolean,
    activation: KanbanBandToggleActivation,
  ) => void;
  /** Band menu or other controls, after the toggle. */
  actions?: ReactNode;
};

/**
 * The band line above a run of columns: one `KANBAN_BAND_CAPTION_ROW_HEIGHT`
 * row of toggle, swatch, name, and count, so a band costs the board a
 * caption's height and nothing more.
 * Folded, only the toggle remains in this line; the band's name moves down
 * into the narrow column body, where the height is already there.
 */
export const KanbanColumnBandHeader = ({
  title,
  swatch,
  meta,
  collapsed,
  compact = collapsed,
  toggleLabel,
  onCollapsedChange,
  actions,
}: KanbanColumnBandHeaderProps) => (
  <div
    className={cn(
      "flex items-center gap-1",
      KANBAN_BAND_CAPTION_ROW_HEIGHT,
      compact ? "justify-center" : "pe-1",
    )}
    data-collapsed={collapsed ? "" : undefined}
    data-compact={compact ? "" : undefined}
    data-slot="kanban-column-band-header"
  >
    <button
      aria-expanded={!collapsed}
      aria-label={toggleLabel}
      className="hover:bg-muted/60 text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md transition-[background-color]"
      // A keyboard activation reports no click count, so the board can tell a
      // fold that leaves the pointer over the new slot from one that does not.
      onClick={(event) =>
        onCollapsedChange(!collapsed, { viaPointer: event.detail > 0 })
      }
      title={toggleLabel}
      type="button"
    >
      <DirectionalIcon
        className={cn(
          "size-3.5 transition-transform",
          collapsed && "-rotate-90",
        )}
        flip={collapsed}
        icon={ChevronDownIcon}
      />
    </button>
    {compact ? null : (
      <>
        {swatch}
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate text-xs font-medium">
          {title}
          {meta !== undefined && (
            <span className="text-muted-foreground font-normal tabular-nums">
              {meta}
            </span>
          )}
        </span>
        {actions}
      </>
    )}
  </div>
);
