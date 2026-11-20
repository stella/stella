import type { ReactNode } from "react";

import { TRUNCATED_TEXT_LINES_CLASS } from "../components/truncated-text-face";
import { cn } from "../lib/utils";
import { KANBAN_CHROME_ROW_HEIGHT } from "./layout-tokens";

// The width every board column takes, for a loading board that lays its
// column headers out where the board will.
export { KANBAN_COLUMN_WIDTH_CLASS } from "./layout-tokens";

/** The column name and its count, as one cut line of text. */
export const KANBAN_COLUMN_NAME_CLASS =
  "flex flex-1 items-center gap-1.5 text-sm font-medium";

/**
 * The column name and count's line before the board knows them: the line the
 * header cuts its name on, holding whatever stands in for the two.
 */
export const KanbanColumnNameFace = ({ children }: { children: ReactNode }) => (
  <span
    aria-hidden="true"
    className={cn(TRUNCATED_TEXT_LINES_CLASS[1], KANBAN_COLUMN_NAME_CLASS)}
  >
    {children}
  </span>
);

export type KanbanColumnHeaderShellProps = {
  /** Colour swatch, or the control that changes it. */
  swatch?: ReactNode;
  /** The column's name and count, as the header draws them. */
  name: ReactNode;
  /** Column calculation, rendered after the count. */
  calculation?: ReactNode;
  /** Drag affordance, revealed on hover over the column. */
  dragHandle?: ReactNode;
  /** Column menu. */
  actions?: ReactNode;
};

/**
 * Where a column header's name sits: the swatch and the name, held at the
 * visible edge of a board scrolled sideways. The header and its loading face
 * both put their name here.
 */
export const KanbanColumnTitleSlot = ({
  swatch,
  name,
}: {
  swatch?: ReactNode;
  name: ReactNode;
}) => (
  // How far the name may travel: up to where the row's own controls begin,
  // so a name holding the visible edge of a board scrolled sideways never
  // slides over the calculation or the column's menu.
  <div className="flex min-w-0 flex-1">
    {/* The name travels the width of its own column: a board scrolled
     * sideways keeps it at the visible edge until the column it names is
     * gone, rather than leaving the cards below it unlabelled. It has to
     * size to its content to have any room to travel. `bg-inherit` repaints
     * whatever surface the header row itself carries, and stays out of the
     * way of the accent a caller washes the header cell around it with. */}
    <div
      className="sticky start-0 z-10 flex w-fit max-w-full items-center gap-2 bg-inherit"
      data-kanban-column-title=""
    >
      {swatch}
      {name}
    </div>
  </div>
);

/**
 * The column header row before the board mounts: the header's row with its
 * title slot and controls, so the header that replaces it lands in the same
 * row. It imports no tooltip or popup.
 */
export const KanbanColumnHeaderShell = ({
  swatch,
  name,
  calculation,
  dragHandle,
  actions,
}: KanbanColumnHeaderShellProps) => (
  <div
    className={cn("flex items-center gap-2 px-3", KANBAN_CHROME_ROW_HEIGHT)}
    data-kanban-column-header=""
  >
    <KanbanColumnTitleSlot name={name} swatch={swatch} />
    {calculation}
    {dragHandle}
    {actions}
  </div>
);
