import type { ReactNode } from "react";

import { TruncatedText } from "../components/truncated-text";
import { cn } from "../lib/utils";
import {
  KANBAN_COLUMN_NAME_CLASS,
  KanbanColumnTitleSlot,
} from "./column-header-shell";
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
    data-kanban-column-header=""
  >
    <KanbanColumnTitleSlot
      name={
        <TruncatedText className={KANBAN_COLUMN_NAME_CLASS}>
          {title}
          {meta !== undefined && (
            <span className="text-muted-foreground text-xs">{meta}</span>
          )}
        </TruncatedText>
      }
      swatch={swatch}
    />
    {calculation}
    {dragHandle}
    {actions}
  </div>
);
