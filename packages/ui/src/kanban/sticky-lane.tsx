import type { CSSProperties, ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * A lane's controls while its cells scroll.
 *
 * A board's header block is sticky at the top of the board's scroll
 * container, so anything else that must stay readable has to come to rest
 * under it rather than behind it. The board publishes how far its header
 * reaches in this custom property; a control sticks at that offset and
 * releases where its lane ends, because the lane's own box is what bounds it.
 */
export const KANBAN_STICKY_TOP_VAR = "--kanban-sticky-top" as const;

/**
 * Sticks a lane control just under the board's header. The fallback keeps a
 * control usable outside a board that publishes the offset, and inside a cell
 * that keeps its own scroll surface, where the board's header is irrelevant.
 */
export const KANBAN_STICKY_TOP_CLASS = "top-(--kanban-sticky-top,0px)";

export type KanbanStickyTopStyle = CSSProperties & {
  [KANBAN_STICKY_TOP_VAR]?: string;
};

export type KanbanCollapsedBandCaptionProps = {
  label: string;
  /** What the folded band stands in for: its count, already formatted. */
  meta: ReactNode;
  className?: string | undefined;
};

/**
 * The name and count of a folded band, set vertically in its narrow slot.
 *
 * It stays under the board's header for as long as the lane lasts, so a
 * folded band still says which band it is halfway down a tall lane. The slot
 * has to give it room to travel: the element around it fills the slot's
 * height (`h-full`), or a caption as tall as its own text can never move.
 * A host rendering its own collapsed cell composes this inside that cell.
 */
export const KanbanCollapsedBandCaption = ({
  className,
  label,
  meta,
}: KanbanCollapsedBandCaptionProps) => (
  <div
    className={cn(
      "text-muted-foreground sticky flex w-full flex-col items-center gap-2 self-start py-2 text-xs",
      KANBAN_STICKY_TOP_CLASS,
      className,
    )}
    data-kanban-collapsed-band-caption=""
  >
    <span className="max-h-40 truncate font-medium [writing-mode:vertical-rl]">
      {label}
    </span>
    <span className="tabular-nums">{meta}</span>
  </div>
);
