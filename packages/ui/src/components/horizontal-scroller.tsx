"use client";

import { useCallback, useState } from "react";
import type { ComponentProps, UIEvent } from "react";

import { containedEventHandler } from "../hooks/use-contained-handler";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons";
import {
  SCROLL_EDGE_FADE_CLASS,
  writeScrollEdgeFade,
} from "../lib/scroll-edge-fade";
import { cn } from "../lib/utils";

const CONTROL_CLASS =
  "bg-background/90 text-foreground absolute top-1/2 -translate-y-1/2 rounded-full border p-1 shadow-sm";

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
  const [state, setState] = useState<ScrollState>({
    canScrollEnd: false,
    canScrollStart: false,
  });

  const measure = useCallback((node: HTMLDivElement) => {
    writeScrollEdgeFade(node);
    setState(
      scrollState(
        node.scrollLeft,
        node.scrollWidth,
        node.clientWidth,
        getComputedStyle(node).direction === "rtl" ? "rtl" : "ltr",
      ),
    );
  }, []);

  const viewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      setViewport(node);
      if (!node) {
        return undefined;
      }
      // Overflow changes when the viewport resizes and also when its content
      // does at a fixed viewport size (an item added, removed or relabelled),
      // so the viewport and the content row are both observed.
      const observer = new ResizeObserver(() => measure(node));
      observer.observe(node);
      if (node.firstElementChild !== null) {
        observer.observe(node.firstElementChild);
      }
      measure(node);
      // A vertical wheel scrolls the row sideways. React registers wheel
      // handlers as passive, where preventDefault is ignored and the page
      // would scroll as well, so this listener is native and not passive.
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
        observer.disconnect();
        node.removeEventListener("wheel", onWheel);
      };
    },
    [measure],
  );

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

  const onScroll = (event: UIEvent<HTMLDivElement>) =>
    measure(event.currentTarget);

  return (
    <div
      className={cn("relative min-w-0", className)}
      onFocus={containedEventHandler(({ target }) => {
        if (target instanceof HTMLElement && target !== viewport) {
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      })}
      {...props}
    >
      <div
        className={cn(
          "scrollbar-subtle overflow-x-auto overscroll-x-contain [--fade-size:2.5rem]",
          SCROLL_EDGE_FADE_CLASS,
          viewportClassName,
        )}
        onScroll={onScroll}
        ref={viewportRef}
      >
        <div className={cn("w-max min-w-full", contentClassName)}>
          {children}
        </div>
      </div>
      {(state.canScrollStart || state.canScrollEnd) && (
        // Both controls stay mounted while the row overflows: one that
        // reached its edge turns inert instead of unmounting, so keyboard
        // focus on it survives the scroll that got it there. An inert one
        // leaves the tab order and shows only while it still holds focus.
        <>
          <button
            aria-disabled={!state.canScrollStart}
            tabIndex={state.canScrollStart ? undefined : -1}
            aria-label={previousLabel}
            className={cn(
              CONTROL_CLASS,
              "start-1",
              !state.canScrollStart &&
                "pointer-events-none opacity-0 focus-visible:opacity-100",
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
          <button
            aria-disabled={!state.canScrollEnd}
            tabIndex={state.canScrollEnd ? undefined : -1}
            aria-label={nextLabel}
            className={cn(
              CONTROL_CLASS,
              "end-1",
              !state.canScrollEnd &&
                "pointer-events-none opacity-0 focus-visible:opacity-100",
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
        </>
      )}
    </div>
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
