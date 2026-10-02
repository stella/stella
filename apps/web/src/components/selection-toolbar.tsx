import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@stll/ui/utils";

import { selectionToolbarPosition } from "@/components/selection-toolbar.logic";

type SelectionToolbarProps = {
  /** The selected words (or the clicked mark) the bar floats over, in
   *  viewport coordinates. */
  anchorRect: DOMRect;
  /** Names the bar for assistive technology. */
  ariaLabel?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
  /** The document the selection lives in; the bar portals into its body.
   *  Null until the host has mounted, and the bar renders nothing until then. */
  doc: Document | null;
  /** Receives the bar's node, for hosts that must tell a press on the bar
   *  from a press on the text under it. */
  onAttach?: ((node: HTMLDivElement | null) => void) | undefined;
};

/**
 * The floating bar over selected text, shared by the document reader's
 * mark-up bar and the chat's selection actions. It owns placement only:
 * reading the selection and choosing the actions stay with each host,
 * because what counts as a selection differs between them.
 */
export const SelectionToolbar = ({
  anchorRect,
  ariaLabel,
  children,
  className,
  doc,
  onAttach,
}: SelectionToolbarProps) => {
  // The bar's rendered width, learned from the node as React attaches it,
  // so the position can keep the whole bar inside the window.
  const [barWidth, setBarWidth] = useState(0);
  const attachBar = (node: HTMLDivElement | null) => {
    onAttach?.(node);
    setBarWidth(node?.offsetWidth ?? 0);
  };

  const host = doc?.body ?? null;
  if (host === null) {
    return null;
  }

  const position = selectionToolbarPosition({
    anchor: anchorRect,
    barWidth,
    viewportWidth: doc?.defaultView?.innerWidth ?? Number.POSITIVE_INFINITY,
  });

  return createPortal(
    <div
      aria-label={ariaLabel}
      className={cn(
        "bg-popover text-popover-foreground fixed z-[100] max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-md border p-1 text-xs shadow-md",
        className,
      )}
      ref={attachBar}
      role={ariaLabel === undefined ? undefined : "toolbar"}
      style={position}
    >
      {children}
    </div>,
    host,
  );
};
