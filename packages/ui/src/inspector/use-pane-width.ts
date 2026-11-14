import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import {
  clampInspectorPaneWidth,
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  resolveInspectorPaneMaxWidth,
  resolveInspectorPaneWidth,
} from "./pane-width";

/**
 * Width the drag produces for a pane docked to the inline-end edge.
 *
 * That edge is the right in LTR (width = distance from the right) and the
 * left in RTL (width = distance from the left). Without the RTL branch the
 * delta is inverted and the drag oscillates.
 *
 * A pointer can be dragged well past either bound — off the window edge, or
 * across the whole viewport — so the raw distance is clamped here, before
 * anything keeps it. Persisting the raw distance is what made a pane dragged
 * narrower than the minimum from being persisted as an invalid preference.
 */
export const resolveDragWidth = ({
  clientX,
  isRtl,
  viewportWidth,
}: {
  clientX: number;
  isRtl: boolean;
  viewportWidth: number;
}) => clampInspectorPaneWidth(isRtl ? clientX : viewportWidth - clientX);

/** Pixels one arrow press moves the edge; Page/Home/End move further. */
export const INSPECTOR_PANE_KEYBOARD_STEP = 16;
export const INSPECTOR_PANE_KEYBOARD_PAGE_STEP = 64;

/**
 * Width a keyboard resize produces. Returns `null` for keys the handle does
 * not own, so the caller can leave the event alone rather than swallowing
 * every keystroke that reaches a focusable separator.
 *
 * Arrow semantics follow the *edge*, not the width: on an inline-end pane
 * the inline-start arrow grows it. Under RTL the physical arrows swap, so
 * the same key keeps meaning "make it bigger" on both sides.
 */
export const resolveKeyboardWidth = ({
  currentWidth,
  isRtl,
  key,
}: {
  currentWidth: number;
  isRtl: boolean;
  key: string;
}): number | null => {
  const grow = isRtl ? "ArrowRight" : "ArrowLeft";
  const shrink = isRtl ? "ArrowLeft" : "ArrowRight";
  switch (key) {
    case grow:
      return currentWidth + INSPECTOR_PANE_KEYBOARD_STEP;
    case shrink:
      return currentWidth - INSPECTOR_PANE_KEYBOARD_STEP;
    case "PageUp":
      return currentWidth + INSPECTOR_PANE_KEYBOARD_PAGE_STEP;
    case "PageDown":
      return currentWidth - INSPECTOR_PANE_KEYBOARD_PAGE_STEP;
    case "Home":
      return INSPECTOR_PANE_MIN_WIDTH;
    case "End":
      return INSPECTOR_PANE_MAX_WIDTH;
    // Restore the default, mirroring the handle's double-click affordance.
    case "Enter":
      return INSPECTOR_PANE_DEFAULT_WIDTH;
    default:
      return null;
  }
};

export type InspectorPaneWidthPersistence = {
  read: () => number;
  write: (width: number) => void;
};

type UseInspectorPaneWidthOptions = {
  /** Inline size the sidebar takes out of the same layout row. */
  sidebarWidth: number;
  /** Persistence is injected so this package stays independent of its host. */
  persistence?: InspectorPaneWidthPersistence | undefined;
  /** Viewport width in CSS pixels; 0 before the viewport is known. */
  viewportWidth: number;
};

type UseInspectorPaneWidthResult = {
  /**
   * Pointer + keyboard handlers and ARIA state to spread onto the drag
   * handle. The handle is a focusable `separator`, so it is operable
   * without a pointer.
   */
  resizeHandleProps: {
    "aria-orientation": "vertical";
    "aria-valuemax": number;
    "aria-valuemin": number;
    "aria-valuenow": number;
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    tabIndex: number;
  };
  /** Reset the pane to its default width (double-click affordance). */
  resetWidth: () => void;
  /**
   * Width the pane renders at: the dragged width clamped against the room
   * left beside the sidebar.
   */
  width: number;
};

/**
 * Owns the docked pane's width: the width the user dragged to, its
 * persistence, and the clamp against the room actually available.
 *
 * What renders is always the clamped value, so shrinking the window or
 * expanding the sidebar takes space back from the pane instead of crushing
 * the content column. The *desired* width keeps the user's choice, so the
 * pane returns to it once the room comes back.
 */
export const useInspectorPaneWidth = ({
  sidebarWidth,
  persistence,
  viewportWidth,
}: UseInspectorPaneWidthOptions): UseInspectorPaneWidthResult => {
  const [desiredWidth, setDesiredWidth] = useState(() => {
    const saved = persistence?.read();
    return saved === undefined || !Number.isFinite(saved)
      ? INSPECTOR_PANE_DEFAULT_WIDTH
      : clampInspectorPaneWidth(saved);
  });
  const isDragging = useRef(false);
  const lastPersisted = useRef({ persistence, desiredWidth });

  useEffect(() => {
    if (
      persistence === undefined ||
      (lastPersisted.current.persistence === persistence &&
        lastPersisted.current.desiredWidth === desiredWidth)
    ) {
      return;
    }
    persistence.write(desiredWidth);
    lastPersisted.current = { persistence, desiredWidth };
  }, [desiredWidth, persistence]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    isDragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isDragging.current) {
      return;
    }
    setDesiredWidth(
      resolveDragWidth({
        clientX: event.clientX,
        isRtl: document.documentElement.dir === "rtl",
        viewportWidth: window.innerWidth,
      }),
    );
  };

  /**
   * Ends the drag however the pointer stream ended. `pointerup` is only one of
   * the ways: a touch taken over by scrolling, a context menu, or the handle
   * losing capture mid-drag all end it without one, and a drag flag left set
   * would resize the pane on the next pointer movement with no button held.
   */
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    isDragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // What the ceiling actually is at this viewport, not the absolute one: with
  // a viewport-relative maximum, `End` and the reported `aria-valuemax` would
  // otherwise name a width the pane cannot take.
  const maxWidth = resolveInspectorPaneMaxWidth({
    sidebarWidth,
    viewportWidth,
  });

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const next = resolveKeyboardWidth({
      currentWidth: desiredWidth,
      isRtl: document.documentElement.dir === "rtl",
      key: event.key,
    });
    if (next === null) {
      return;
    }
    event.preventDefault();
    setDesiredWidth(Math.min(clampInspectorPaneWidth(next), maxWidth));
  };

  const resetWidth = () => {
    setDesiredWidth(INSPECTOR_PANE_DEFAULT_WIDTH);
  };

  const width = resolveInspectorPaneWidth({
    desiredWidth,
    sidebarWidth,
    viewportWidth,
  });

  return {
    resetWidth,
    resizeHandleProps: {
      "aria-orientation": "vertical",
      "aria-valuemax": maxWidth,
      "aria-valuemin": INSPECTOR_PANE_MIN_WIDTH,
      "aria-valuenow": width,
      onKeyDown: handleKeyDown,
      onLostPointerCapture: endDrag,
      onPointerCancel: endDrag,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: endDrag,
      tabIndex: 0,
    },
    width,
  };
};
