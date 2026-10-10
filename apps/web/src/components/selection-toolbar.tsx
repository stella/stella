import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@stll/ui/utils";

import {
  SELECTION_TOOLBAR_EDGE_MARGIN_PX,
  selectionToolbarPosition,
} from "@/components/selection-toolbar.logic";

type SelectionToolbarProps = {
  /** The selected words (or the clicked mark) the bar floats over, in
   *  viewport coordinates. */
  anchorRect: DOMRect;
  /** Intersection of the scroll container and the visible viewport. */
  boundaryRect: DOMRect;
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
  boundaryRect,
  ariaLabel,
  children,
  className,
  doc,
  onAttach,
}: SelectionToolbarProps) => {
  const [barSize, setBarSize] = useState({ width: 0, height: 0 });
  const attachBar = (node: HTMLDivElement | null) => {
    onAttach?.(node);
    if (node === null) {
      return undefined;
    }
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setBarSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      onAttach?.(null);
    };
  };

  const host = doc?.body ?? null;
  if (host === null) {
    return null;
  }

  const position = selectionToolbarPosition({
    anchor: anchorRect,
    barWidth: barSize.width,
    barHeight: barSize.height,
    bounds: boundaryRect,
  });

  return createPortal(
    <div
      aria-label={ariaLabel}
      className={cn(
        "bg-popover text-popover-foreground fixed z-[100] -translate-x-1/2 rounded-md border p-1 text-xs shadow-md",
        className,
      )}
      ref={attachBar}
      role={ariaLabel === undefined ? undefined : "toolbar"}
      style={{
        ...position,
        maxWidth: Math.max(
          0,
          boundaryRect.width - 2 * SELECTION_TOOLBAR_EDGE_MARGIN_PX,
        ),
        maxHeight: Math.max(
          0,
          boundaryRect.height - 2 * SELECTION_TOOLBAR_EDGE_MARGIN_PX,
        ),
      }}
    >
      {children}
    </div>,
    host,
  );
};
