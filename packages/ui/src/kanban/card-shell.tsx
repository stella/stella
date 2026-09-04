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
   * While they are hidden they are also inert: they take no pointer events at
   * all, so a touch anywhere over the card — including the corner they will
   * appear in — reaches the card itself. A hidden overlay that still answered
   * a press would sit as a small dead zone on every card, and a long press
   * landing in it would never start the card's drag.
   *
   * Each pointer has its own way in. A pointer that hovers reveals them by
   * hovering the card; the keyboard reveals them by tabbing into them, which
   * being inert to a pointer never blocked. A finger has neither, so `active`
   * is its route: the card a tap opened shows its actions for as long as it
   * stays open. A board that never marks a card active leaves touch without
   * one, and should keep `"always"`.
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
      <div
        className="group/card"
        // Published on the group so the hover overlay can answer it: a finger
        // never hovers, and an open card is how it reaches the same actions.
        data-active={active ? "true" : undefined}
        ref={dragRef}
      >
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
    <div
      className="group/card"
      // Published on the group so the hover overlay can answer it: a finger
      // never hovers, and an open card is how it reaches the same actions.
      data-active={active ? "true" : undefined}
      ref={dragRef}
    >
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
 *
 * Every state that shows them also makes them answer a pointer again, and
 * nothing else does: an invisible overlay that still took a press would leave
 * a small dead zone in the corner of every card, and on a touch device that
 * dead zone swallows the long press that starts the card's drag. Hiding alone
 * would not have been enough — a transparent element is still the topmost hit.
 * Focus is unaffected by `pointer-events`, so the keyboard path is untouched.
 *
 * The active card is what leaves a finger a way in, since it has neither
 * hover nor tab: the card a tap opened keeps its actions out while it is
 * open. It reads the state off the group rather than its own card box, so
 * the pair stays in one class string.
 */
const HOVER_ACTIONS_CLASS =
  "absolute end-1.5 top-1.5 z-10 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-data-[active=true]/card:pointer-events-auto group-data-[active=true]/card:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none";
