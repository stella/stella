import type { ReactNode, RefObject } from "react";

import { containedHandler } from "../hooks/use-contained-handler";
import { cn } from "../lib/utils";

export type KanbanCardShellProps = {
  children: ReactNode;
  /** Overlay slot pinned to the top-end corner (row actions). */
  actions?: ReactNode;
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
 */
export const KanbanCardShell = ({
  children,
  actions,
  active,
  onOpen,
  bodyRef,
  dragRef,
  className,
}: KanbanCardShellProps) => {
  const body = (
    <>
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
        // eslint-disable-next-line react/react-compiler -- containedHandler house pattern; bodyRef is handed to the helper, not read for rendered output
        onClick={containedHandler(bodyRef, onOpen)}
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
