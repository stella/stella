import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { holdReferencePeeks } from "@stll/decision-reader/reference-peek-layering";
import { cn } from "@stll/ui/utils";

import {
  SELECTION_TOOLBAR_EDGE_MARGIN_PX,
  selectionToolbarPosition,
} from "@/components/selection-toolbar.logic";
import { useMountEffect } from "@/hooks/use-effect";

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
 * mark-up bar, the PDF viewer's selection bar and the chat's selection
 * actions. It owns placement only: reading the selection and choosing the
 * actions stay with each host, because what counts as a selection differs
 * between them. The actions they share live in `selection-toolbar-actions`.
 *
 * While it is mounted no reference peek opens and an open one closes: the
 * bar the reader asked for wins (see `reference-peek-layering`).
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
  useMountEffect(holdReferencePeeks);
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

  // `w-max`: a fixed box without a width shrinks to the room between its
  // `left` and the viewport's edge, before the translate centres it. Near
  // the right edge that squeezed the bar into rows, and the squeezed width
  // then fed the clamp above. The bar takes its own width; `maxWidth` alone
  // decides when it wraps.
  return createPortal(
    <div
      aria-label={ariaLabel}
      className={cn(
        "bg-popover text-popover-foreground fixed z-[100] w-max -translate-x-1/2 rounded-md border p-1 text-xs shadow-md",
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
