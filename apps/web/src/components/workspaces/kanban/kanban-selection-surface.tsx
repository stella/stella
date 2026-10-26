import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";

import { cn } from "@stll/ui/utils";

import type { KanbanSelection } from "@/components/workspaces/kanban/kanban-selection";
import {
  getMarqueeRect,
  hasPassedMarqueeThreshold,
  isInsideClientArea,
  MARQUEE_MODE,
} from "@/components/workspaces/kanban/kanban-selection.logic";
import type {
  ViewportPoint,
  ViewportRect,
} from "@/components/workspaces/kanban/kanban-selection.logic";
import { useMountEffect } from "@/hooks/use-effect";

/**
 * Where a marquee may not start: on a card (that is a click or a card drag),
 * on the board's own chrome, or on any control.
 */
const MARQUEE_BLOCKING_SELECTOR = [
  "[data-kanban-card]",
  "[data-kanban-column-header]",
  "[data-kanban-board-header]",
  "[data-kanban-lane-identity]",
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable]",
  '[role="button"]',
  '[role="menu"]',
  '[role="dialog"]',
].join(", ");

/** Only a precise pointer draws a marquee; a finger on the board scrolls it. */
const MARQUEE_POINTER_TYPES = new Set(["mouse", "pen"]);

const isMarqueeStart = (event: ReactPointerEvent<HTMLElement>): boolean => {
  const { target } = event;
  if (
    event.button !== 0 ||
    !MARQUEE_POINTER_TYPES.has(event.pointerType) ||
    !(target instanceof Element) ||
    // React bubbles events out of portals (menus, popovers) through the
    // component tree; only a press on the board itself starts a marquee.
    !event.currentTarget.contains(target) ||
    target.closest(MARQUEE_BLOCKING_SELECTOR) !== null
  ) {
    return false;
  }
  // A press on a scroll container's scrollbar targets the container itself;
  // only its client area counts as empty board.
  return isInsideClientArea({
    point: { x: event.clientX, y: event.clientY },
    rect: target.getBoundingClientRect(),
    clientLeft: target.clientLeft,
    clientTop: target.clientTop,
    clientWidth: target.clientWidth,
    clientHeight: target.clientHeight,
  });
};

type KanbanSelectionSurfaceProps = {
  selection: KanbanSelection;
  children: ReactNode;
  className?: string | undefined;
};

/**
 * The board area that owns selection gestures: a drag over empty board draws
 * a marquee that selects the cards it touches, a click there clears the
 * selection, and Escape clears it anywhere. Holding Cmd/Ctrl or Shift while
 * starting the marquee adds to the selection instead.
 *
 * Only the overlay re-renders while the marquee moves: `children` keeps its
 * identity, so the board under it does not.
 */
export const KanbanSelectionSurface = ({
  selection,
  children,
  className,
}: KanbanSelectionSurfaceProps) => {
  const gestureRef = useRef<AbortController | null>(null);
  const [overlay, setOverlay] = useState<ViewportRect | null>(null);

  useHotkey("Escape", selection.clear, { ignoreInputs: true });

  useMountEffect(() => () => gestureRef.current?.abort());

  const startGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    if (!isMarqueeStart(event)) {
      return;
    }
    gestureRef.current?.abort();
    const controller = new AbortController();
    gestureRef.current = controller;

    const start: ViewportPoint = { x: event.clientX, y: event.clientY };
    const base = selection.getState();
    const mode =
      event.shiftKey || event.metaKey || event.ctrlKey
        ? MARQUEE_MODE.add
        : MARQUEE_MODE.replace;
    let active = false;
    // Dragging across cards would otherwise select their text.
    const previousUserSelect = root.style.userSelect;
    root.style.userSelect = "none";

    const finish = () => {
      controller.abort();
      if (gestureRef.current === controller) {
        gestureRef.current = null;
      }
      root.style.userSelect = previousUserSelect;
      setOverlay(null);
    };

    window.addEventListener(
      "pointermove",
      (moveEvent) => {
        const current = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!active && !hasPassedMarqueeThreshold(start, current)) {
          return;
        }
        active = true;
        const rect = getMarqueeRect(start, current);
        const origin = root.getBoundingClientRect();
        setOverlay({
          left: rect.left - origin.left,
          top: rect.top - origin.top,
          right: rect.right - origin.left,
          bottom: rect.bottom - origin.top,
        });
        selection.selectMarquee({ base, rect, mode });
      },
      { signal: controller.signal },
    );
    window.addEventListener(
      "pointerup",
      () => {
        // A click on empty board, as in the file tree, clears the selection.
        if (!active && mode === MARQUEE_MODE.replace) {
          selection.clear();
        }
        finish();
      },
      { signal: controller.signal },
    );
    window.addEventListener("pointercancel", finish, {
      signal: controller.signal,
    });
    window.addEventListener("blur", finish, { signal: controller.signal });
  };

  return (
    <div
      className={cn("relative min-h-0", className)}
      onPointerDown={startGesture}
    >
      {children}
      {overlay && (
        <div
          aria-hidden="true"
          className="border-primary/40 bg-primary/5 pointer-events-none absolute z-30 rounded-sm border"
          // Pointer coordinates are physical in both directions, so the
          // rectangle is placed physically too.
          style={{
            left: overlay.left,
            top: overlay.top,
            width: overlay.right - overlay.left,
            height: overlay.bottom - overlay.top,
          }}
        />
      )}
    </div>
  );
};
