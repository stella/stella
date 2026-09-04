import type { ReactNode, RefObject } from "react";

import { containedEventHandler } from "../hooks/use-contained-handler";
import { cn } from "../lib/utils";
import { KANBAN_CARD_STICKY_TOP_CLASS } from "./sticky-lane";

export type KanbanCardShellProps = {
  children: ReactNode;
  /** Overlay slot pinned to the top-end corner (row actions). */
  actions?: ReactNode;
  /**
   * Whether `actions` are drawn at all times or only once the card is under
   * the pointer. `"hover"` also hands their placement to the shell, so the
   * quiet actions of every board rest in the same corner and a caller passes
   * bare icon buttons; `"always"` (the default) leaves a caller's own overlay
   * exactly where it put it.
   *
   * A pointer that cannot hover would never reveal them, so a coarse pointer
   * keeps them shown.
   */
  actionsVisibility?: "always" | "hover" | undefined;
  /**
   * The card's identity row: whatever says which card this is, held at the top
   * of the card while the card scrolls past under it, and released where the
   * card ends. A card taller than the viewport otherwise loses its own name
   * halfway down. Omit it and the card renders exactly as it did before.
   *
   * The row runs the card's full width and the actions overlay leads the same
   * corner over it, so leave the row's end side clear of anything the actions
   * would cover.
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
  actionsVisibility = "always",
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
      {actionsVisibility === "hover" && actions !== undefined ? (
        <div className={HOVER_ACTIONS_CLASS} data-kanban-card-actions="hover">
          {actions}
        </div>
      ) : (
        actions
      )}
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
 * `bg-card` on its own is not enough: a consumer is free to define that token
 * with an alpha channel, and a translucent pinned row lets the very cards it
 * is holding back read through it. The card colour goes down as a flat
 * gradient layer over the opaque page background instead, which is the card's
 * own surface at full opacity whatever the token turns out to be.
 *
 * No `z-index`: being positioned is already enough to paint over the card's
 * flow content, and taking a layer would put the row over the `actions`
 * overlay, which callers anchor to the same corner with no layer of its own.
 * Tree order settles the rest, and the row renders before `actions`.
 */
const STICKY_HEADER_CLASS =
  "bg-background bg-[linear-gradient(var(--color-card),var(--color-card))] sticky mb-2 border-b pb-2";

/**
 * Where the shell puts the actions it reveals on hover.
 *
 * The overlay takes a layer of its own here, unlike the always-visible slot:
 * it has to stay over the pinned identity row that leads the same corner, and
 * the row's own comment explains why the row cannot take one instead. An open
 * menu holds the actions on through its trigger's `aria-expanded`, or the
 * trigger would disappear from under the popup it just opened.
 *
 * The fade is decoration: a reader who asked for less motion still gets the
 * actions, they simply arrive at once.
 */
const HOVER_ACTIONS_CLASS =
  "absolute end-1.5 top-1.5 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100";
