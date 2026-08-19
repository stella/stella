import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import {
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  resolveInspectorPaneWidth,
} from "./pane-width";

/**
 * Reads a persisted pane width, rejecting anything that is not a finite
 * number inside the pane's own bounds. A corrupt or stale entry must not
 * be able to render the pane at a width the drag handle cannot recover
 * from, so an unusable value falls back to the default rather than being
 * clamped into something the user never chose.
 */
export const parsePersistedPaneWidth = (raw: string | null): number => {
  if (raw === null) {
    return INSPECTOR_PANE_DEFAULT_WIDTH;
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < INSPECTOR_PANE_MIN_WIDTH ||
    parsed > INSPECTOR_PANE_MAX_WIDTH
  ) {
    return INSPECTOR_PANE_DEFAULT_WIDTH;
  }
  return parsed;
};

/**
 * Width the drag produces for a pane docked to the inline-end edge.
 *
 * That edge is the right in LTR (width = distance from the right) and the
 * left in RTL (width = distance from the left). Without the RTL branch the
 * delta is inverted and the drag oscillates.
 */
export const resolveDragWidth = ({
  clientX,
  isRtl,
  viewportWidth,
}: {
  clientX: number;
  isRtl: boolean;
  viewportWidth: number;
}) => (isRtl ? clientX : viewportWidth - clientX);

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

type UseInspectorPaneWidthOptions = {
  /** Inline size the sidebar takes out of the same layout row. */
  sidebarWidth: number;
  /**
   * `localStorage` key the dragged width is remembered under. Omit to keep
   * the width in memory only (Stella's original behaviour).
   */
  storageKey?: string | undefined;
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
  storageKey,
  viewportWidth,
}: UseInspectorPaneWidthOptions): UseInspectorPaneWidthResult => {
  const [desiredWidth, setDesiredWidth] = useState(() => {
    if (storageKey === undefined || typeof window === "undefined") {
      return INSPECTOR_PANE_DEFAULT_WIDTH;
    }
    return parsePersistedPaneWidth(window.localStorage.getItem(storageKey));
  });
  const isDragging = useRef(false);

  useEffect(() => {
    if (storageKey === undefined || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(storageKey, String(desiredWidth));
  }, [desiredWidth, storageKey]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      isDragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
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
    },
    [],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      isDragging.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const next = resolveKeyboardWidth({
        currentWidth: desiredWidth,
        isRtl: document.documentElement.dir === "rtl",
        key: event.key,
      });
      if (next === null) {
        return;
      }
      event.preventDefault();
      setDesiredWidth(
        Math.min(
          Math.max(next, INSPECTOR_PANE_MIN_WIDTH),
          INSPECTOR_PANE_MAX_WIDTH,
        ),
      );
    },
    [desiredWidth],
  );

  const resetWidth = useCallback(() => {
    setDesiredWidth(INSPECTOR_PANE_DEFAULT_WIDTH);
  }, []);

  const width = resolveInspectorPaneWidth({
    desiredWidth,
    sidebarWidth,
    viewportWidth,
  });

  return {
    resetWidth,
    resizeHandleProps: {
      "aria-orientation": "vertical",
      "aria-valuemax": INSPECTOR_PANE_MAX_WIDTH,
      "aria-valuemin": INSPECTOR_PANE_MIN_WIDTH,
      "aria-valuenow": width,
      onKeyDown: handleKeyDown,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      tabIndex: 0,
    },
    width,
  };
};
