import type { ReactNode, RefObject } from "react";

import { containedEventHandler } from "../hooks/use-contained-handler";
import { cn } from "../lib/utils";
import { KANBAN_CARD_STICKY_TOP_CLASS } from "./sticky-lane";

export type KanbanCardShellProps = {
  children: ReactNode;
  /** Overlay slot pinned to the top-end corner (row actions). */
  actions?: ReactNode;
  /**
   * The card's identity row: whatever says which card this is, held at the top
   * of the card while the card scrolls past under it, and released where the
   * card ends. A card taller than the viewport otherwise loses its own name
   * halfway down. Omit it and the card renders exactly as it did before.
   *
   * Booleans are excluded so `condition && <Row />` cannot reach the slot: a
   * `false` React renders as nothing would still leave the row's divider and
   * spacing behind. Write the absent case as `condition ? <Row /> : null`.
   */
  stickyHeader?: Exclude<ReactNode, boolean>;
  /** Marks the card whose detail is currently open. */
  active?: boolean | undefined;
  /**
   * Opens the card. Omit for a card with nothing to open: the shell then
   * renders a plain region instead of a button, so a card that does nothing
   * never lands in the tab order.
   */
  onOpen?: (() => void) | undefined;
  /** The card body, for callers that measure or flash it. */
  bodyRef?: RefObject<HTMLDivElement | null> | undefined;
  /** The drag source the shell wraps the card in. */
  dragRef?: RefObject<HTMLDivElement | null> | undefined;
  className?: string | undefined;
};

/**
 * The card chrome: border, hover lift, active ring, drag wrapper, and the
 * keyboard contract for a card that opens something.
 *
 * The shell carries no idea of what a card holds. Every board rendered one of
 * three near-identical copies of this markup, differing only in whether the
 * card opened anything, which is why opening is a prop rather than a branch at
 * each call site.
 *
 * Nothing here clips its overflow: a pinned identity row stops sticking the
 * moment anything between it and the scroll container clips.
 */
export const KanbanCardShell = ({
  children,
  actions,
  stickyHeader,
  active,
  onOpen,
  bodyRef,
  dragRef,
  className,
}: KanbanCardShellProps) => {
  const body = (
    <>
      {stickyHeader === undefined || stickyHeader === null ? null : (
        <div
          className={cn(STICKY_HEADER_CLASS, KANBAN_CARD_STICKY_TOP_CLASS)}
          data-kanban-card-sticky-header=""
        >
          {stickyHeader}
        </div>
      )}
      {children}
      {actions}
    </>
  );

  if (!onOpen) {
    return (
      <div className="group/card" ref={dragRef}>
        <div
          className={cn(CARD_CLASS, active && ACTIVE_CLASS, className)}
          ref={bodyRef}
        >
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="group/card" ref={dragRef}>
      <div
        className={cn(
          CARD_CLASS,
          "cursor-pointer transition-shadow hover:shadow-md",
          active && ACTIVE_CLASS,
          className,
        )}
        onClick={containedEventHandler(onOpen)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          // Space scrolls the board otherwise, which moves the card out from
          // under the pointer while it is being opened.
          event.preventDefault();
          onOpen();
        }}
        ref={bodyRef}
        role="button"
        tabIndex={0}
      >
        {body}
      </div>
    </div>
  );
};

const CARD_CLASS =
  "bg-card relative block w-full rounded-lg border p-3 text-start shadow-xs";

const ACTIVE_CLASS = "ring-primary/30 ring-2";

/**
 * The card's own surface repeated on the pinned row, so the rest of the card
 * passes behind it instead of reading through it, ruled off with the card's own
 * border weight.
 *
 * No `z-index`: being positioned is already enough to paint over the card's
 * flow content, and taking a layer would put the row over the `actions`
 * overlay, which callers anchor to the same corner with no layer of its own.
 * Tree order settles the rest, and the row renders before `actions`.
 */
const STICKY_HEADER_CLASS = "bg-card sticky mb-2 border-b pb-2";
