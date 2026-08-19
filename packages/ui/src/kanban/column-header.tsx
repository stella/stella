import type { ReactNode } from "react";

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
};

/**
 * The column header row: one rhythm for the swatch, the name, the count, the
 * calculation, and the column's controls, so every board's header lines up.
 */
export const KanbanColumnHeader = ({
  swatch,
  title,
  meta,
  calculation,
  dragHandle,
  actions,
}: KanbanColumnHeaderProps) => (
  <div className="flex items-center gap-2 px-3 py-2">
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
