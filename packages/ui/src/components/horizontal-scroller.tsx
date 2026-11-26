"use client";

import { useState } from "react";
import type { ComponentProps } from "react";

import { useObservedValue } from "../effects/dom";
import { useExternalSyncEffect } from "../effects/effects";
import { containedEventHandler } from "../hooks/use-contained-handler";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons";
import {
  SCROLL_EDGE_FADE_CLASS,
  writeScrollEdgeFade,
} from "../lib/scroll-edge-fade";
import { cn } from "../lib/utils";

// The controls sit beside the viewport, never over an item. One that cannot
// scroll takes no room, so the row starts flush with the edge it has reached.
const CONTROL_CLASS =
  "bg-background text-foreground shrink-0 rounded-full border p-1 shadow-sm";
const INERT_CONTROL_CLASS =
  "pointer-events-none w-0 overflow-hidden border-0 p-0 opacity-0 focus-visible:w-auto focus-visible:border focus-visible:p-1 focus-visible:opacity-100";

type ScrollDirection = "ltr" | "rtl";

type HorizontalScrollerProps = ComponentProps<"div"> & {
  nextLabel: string;
  previousLabel: string;
  /** Lays out the items: the row that may grow wider than the viewport. */
  contentClassName?: string;
  viewportClassName?: string;
};

type ScrollState = {
  canScrollEnd: boolean;
  canScrollStart: boolean;
};

export const HorizontalScroller = ({
  children,
  className,
  nextLabel,
  previousLabel,
  contentClassName,
  viewportClassName,
  ...props
}: HorizontalScrollerProps) => {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  // Overflow changes when the viewport resizes, when its content does at a
  // fixed viewport size (an item added, removed or relabelled), and as it
  // scrolls, so the viewport, the content row and scrolling are observed.
  const state = useObservedValue<HTMLDivElement, ScrollState>(
    viewport,
    (node, emit) => {
      const measure = () => {
        writeScrollEdgeFade(node);
        emit(measureScrollState(node));
      };
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      if (node.firstElementChild !== null) {
        observer.observe(node.firstElementChild);
      }
      node.addEventListener("scroll", measure, { passive: true });
      measure();
      return () => {
        observer.disconnect();
        node.removeEventListener("scroll", measure);
      };
    },
    [],
    NO_SCROLL,
  );

  // A vertical wheel scrolls the row sideways. React registers wheel
  // handlers as passive, where preventDefault is ignored and the page
  // would scroll as well, so this listener is native and not passive.
  useExternalSyncEffect(() => {
    if (viewport === null) {
      return undefined;
    }
    const node = viewport;
    const onWheel = (event: WheelEvent) => {
      // Ctrl+wheel is pinch-to-zoom on trackpads: leave it to the page.
      if (
        event.ctrlKey ||
        event.deltaX !== 0 ||
        event.deltaY === 0 ||
        node.scrollWidth <= node.clientWidth
      ) {
        return;
      }
      // Down means towards later items: inline end, which is negative
      // scrollLeft in a right-to-left row. At the edge the wheel is asked
      // to move past, the gesture belongs to the page again.
      const rtl = getComputedStyle(node).direction === "rtl";
      const { canScrollEnd, canScrollStart } = scrollState(
        node.scrollLeft,
        node.scrollWidth,
        node.clientWidth,
        rtl ? "rtl" : "ltr",
      );
      if (event.deltaY > 0 ? !canScrollEnd : !canScrollStart) {
        return;
      }
      event.preventDefault();
      const delta = wheelDeltaPixels(event, node);
      node.scrollBy({ left: rtl ? -delta : delta });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
    };
  }, [viewport]);

  const scroll = (inlineDirection: -1 | 1) => {
    if (!viewport) {
      return;
    }
    const rtl = getComputedStyle(viewport).direction === "rtl";
    viewport.scrollBy({
      behavior: "smooth",
      left: viewport.clientWidth * 0.8 * inlineDirection * (rtl ? -1 : 1),
    });
  };

  const overflows = state.canScrollStart || state.canScrollEnd;

  return (
    <div
      className={cn("flex min-w-0 items-center", className)}
      onFocus={containedEventHandler(({ target }) => {
        if (target instanceof HTMLElement && target !== viewport) {
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      })}
      {...props}
    >
      {/* Both controls stay mounted while the row overflows: one that
          reached its edge turns inert instead of unmounting, so keyboard
          focus on it survives the scroll that got it there. An inert one
          leaves the tab order and shows only while it still holds focus. */}
      {overflows && (
        <button
          aria-disabled={!state.canScrollStart}
          tabIndex={state.canScrollStart ? undefined : -1}
          aria-label={previousLabel}
          className={cn(
            CONTROL_CLASS,
            state.canScrollStart ? "me-1" : INERT_CONTROL_CLASS,
          )}
          onClick={() => {
            if (state.canScrollStart) {
              scroll(-1);
            }
          }}
          type="button"
        >
          <ChevronLeftIcon className="size-4 rtl:rotate-180" />
        </button>
      )}
      <div
        className={cn(
          "scrollbar-subtle min-w-0 flex-1 overflow-x-auto overscroll-x-contain [--fade-size:2.5rem]",
          SCROLL_EDGE_FADE_CLASS,
          viewportClassName,
        )}
        ref={setViewport}
      >
        <div className={cn("w-max min-w-full", contentClassName)}>
          {children}
        </div>
      </div>
      {overflows && (
        <button
          aria-disabled={!state.canScrollEnd}
          tabIndex={state.canScrollEnd ? undefined : -1}
          aria-label={nextLabel}
          className={cn(
            CONTROL_CLASS,
            state.canScrollEnd ? "ms-1" : INERT_CONTROL_CLASS,
          )}
          onClick={() => {
            if (state.canScrollEnd) {
              scroll(1);
            }
          }}
          type="button"
        >
          <ChevronRightIcon className="size-4 rtl:rotate-180" />
        </button>
      )}
    </div>
  );
};

const NO_SCROLL: ScrollState = { canScrollEnd: false, canScrollStart: false };

// The controls' state for the viewport as it is now laid out.
const measureScrollState = (node: HTMLDivElement): ScrollState => {
  const rowWidth = rowContentWidth(node.parentElement) ?? node.clientWidth;
  return fitsRow(node.scrollWidth, rowWidth)
    ? NO_SCROLL
    : scrollState(
        node.scrollLeft,
        node.scrollWidth,
        node.clientWidth,
        getComputedStyle(node).direction === "rtl" ? "rtl" : "ltr",
      );
};

export const scrollState = (
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  direction: ScrollDirection,
): ScrollState => {
  const maximum = Math.max(0, scrollWidth - clientWidth);
  const position = direction === "rtl" ? Math.abs(scrollLeft) : scrollLeft;
  return {
    canScrollStart: maximum > 1 && position > 1,
    canScrollEnd: maximum > 1 && position < maximum - 1,
  };
};

/**
 * The width the row's children span: the room the controls and the viewport
 * share, without the row's own padding, in either direction.
 */
const rowContentWidth = (row: Element | null): number | undefined => {
  const first = row?.firstElementChild?.getBoundingClientRect();
  const last = row?.lastElementChild?.getBoundingClientRect();
  if (first === undefined || last === undefined) {
    return undefined;
  }
  return Math.max(first.right, last.right) - Math.min(first.left, last.left);
};

/**
 * Whether the content needs the controls at all, decided from `rowWidth`, the
 * whole width the scroller has: the controls take room from the viewport once
 * they show, and content that fits the row without them needs none.
 */
export const fitsRow = (scrollWidth: number, rowWidth: number): boolean =>
  scrollWidth - rowWidth <= 1;

const LINE_HEIGHT_PX = 16;

/** Wheel deltas arrive in pixels, lines or pages; scrollBy takes pixels. */
export const wheelDeltaPixels = (
  event: Pick<WheelEvent, "deltaMode" | "deltaY">,
  node: Pick<HTMLElement, "clientWidth">,
): number => {
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE: {
      return event.deltaY * LINE_HEIGHT_PX;
    }
    case WheelEvent.DOM_DELTA_PAGE: {
      return event.deltaY * node.clientWidth;
    }
    default: {
      return event.deltaY;
    }
  }
};
