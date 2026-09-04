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

/**
 * How far everything already pinned above a card reaches: the board's header
 * block plus a cell's own pinned action, where the cell pins one. A card taller
 * than the viewport keeps its identity row visible by sticking at this offset,
 * so the row comes to rest under the action rather than behind it. The cell
 * publishes it on each row it renders, because only the cell knows how tall its
 * own pinned action turned out and how far it translated that row.
 */
export const KANBAN_CARD_STICKY_TOP_VAR = "--kanban-card-sticky-top" as const;

/**
 * Sticks a card's identity row under everything pinned above it. The fallback
 * keeps the row usable inside a card rendered outside a cell that publishes the
 * offset, where nothing is pinned above it at all.
 */
export const KANBAN_CARD_STICKY_TOP_CLASS =
  "top-(--kanban-card-sticky-top,0px)";

export type KanbanCardStickyTopStyle = CSSProperties & {
  [KANBAN_CARD_STICKY_TOP_VAR]?: string;
};

type ResolveKanbanCardStickyTopOptions = {
  /** How far the cell's own pinned action reaches, in pixels. */
  pinnedAbove: number;
  /** How far the virtualizer translated the row the card sits in, in pixels. */
  rowOffset: number;
};

/**
 * The offset a card's identity row sticks at, in the row's own coordinates.
 *
 * A virtualized row is translated into place, and a transform between a sticky
 * box and its scroll container is resolved in the translated space: asking for
 * the board's offset there lands the row that far below its card, which parks
 * it at the card's end instead. Subtracting the translation back out states the
 * offset in the space the browser actually resolves it in, so every card pins
 * where the chrome above it ends no matter how far down the lane it is.
 */
export const resolveKanbanCardStickyTop = ({
  pinnedAbove,
  rowOffset,
}: ResolveKanbanCardStickyTopOptions) => {
  const offset = pinnedAbove - rowOffset;
  const sign = offset < 0 ? "-" : "+";
  return `calc(var(${KANBAN_STICKY_TOP_VAR}, 0px) ${sign} ${String(Math.abs(offset))}px)`;
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
    {/* The band's own name, at the weight the open caption sets it in: a
        folded band still names the columns it stands for. */}
    <span className="max-h-40 truncate font-semibold [writing-mode:vertical-rl]">
      {label}
    </span>
    <span className="tabular-nums">{meta}</span>
  </div>
);
