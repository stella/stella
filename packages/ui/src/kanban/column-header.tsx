import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { KANBAN_CHROME_ROW_HEIGHT } from "./layout-tokens";

export type KanbanColumnHeaderProps = {
  /** Colour swatch, or the control that changes it. */
  swatch?: ReactNode;
  /** The column name, or the editor that has taken its place. */
  title: ReactNode;
  /** Short text after the name, such as the card count the caller formatted. */
  meta?: ReactNode;
  /** Column calculation, rendered after the count. */
  calculation?: ReactNode;
  /** Drag affordance, revealed on hover over the column. */
  dragHandle?: ReactNode;
  /** Column menu. */
  actions?: ReactNode;
  /** Extra classes, e.g. to opt a caller out of the default row height. */
  className?: string;
};

/**
 * The column header row: one rhythm for the swatch, the name, the count, the
 * calculation, and the column's controls, so every board's header lines up.
 *
 * Fixed at `KANBAN_CHROME_ROW_HEIGHT`, the height a lane's own rows take, so
 * every chrome row on the board sits on one rhythm and a column's top edge
 * lines up with the lane rows under it. The title clips instead of wrapping
 * so a long name can never grow the row past that height.
 */
export const KanbanColumnHeader = ({
  swatch,
  title,
  meta,
  calculation,
  dragHandle,
  actions,
  className,
}: KanbanColumnHeaderProps) => (
  <div
    className={cn(
      "flex items-center gap-2 px-3",
      KANBAN_CHROME_ROW_HEIGHT,
      className,
    )}
  >
    {swatch}
    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
      {title}
      {meta !== undefined && (
        <span className="text-muted-foreground text-xs">{meta}</span>
      )}
    </span>
    {calculation}
    {dragHandle}
    {actions}
  </div>
);
