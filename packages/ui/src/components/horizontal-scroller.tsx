"use client";

import { useCallback, useState } from "react";
import type { ComponentProps, UIEvent } from "react";

import { containedEventHandler } from "../hooks/use-contained-handler";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons";
import { cn } from "../lib/utils";

type ScrollDirection = "ltr" | "rtl";

type HorizontalScrollerProps = ComponentProps<"div"> & {
  nextLabel: string;
  previousLabel: string;
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
  viewportClassName,
  ...props
}: HorizontalScrollerProps) => {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<ScrollState>({
    canScrollEnd: false,
    canScrollStart: false,
  });

  const measure = useCallback((node: HTMLDivElement) => {
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
      // so both the viewport and each child are observed.
      const observer = new ResizeObserver(() => measure(node));
      const observeAll = () => {
        observer.disconnect();
        observer.observe(node);
        for (const child of node.children) {
          observer.observe(child);
        }
      };
      observeAll();
      const childList = new MutationObserver(() => {
        observeAll();
        measure(node);
      });
      childList.observe(node, { childList: true });
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
        event.preventDefault();
        // Down means towards later items: inline end, which is negative
        // scrollLeft in a right-to-left row.
        const rtl = getComputedStyle(node).direction === "rtl";
        const delta = wheelDeltaPixels(event, node);
        node.scrollBy({ left: rtl ? -delta : delta });
      };
      node.addEventListener("wheel", onWheel, { passive: false });
      return () => {
        observer.disconnect();
        childList.disconnect();
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
          "scrollbar-subtle overflow-x-auto overscroll-x-contain",
          viewportClassName,
        )}
        onScroll={onScroll}
        ref={viewportRef}
      >
        {children}
      </div>
      {state.canScrollStart && (
        <>
          <div className="from-background pointer-events-none absolute inset-y-0 start-0 w-10 bg-linear-to-r to-transparent rtl:bg-linear-to-l" />
          <button
            aria-label={previousLabel}
            className="bg-background/90 text-foreground absolute start-1 top-1/2 -translate-y-1/2 rounded-full border p-1 shadow-sm"
            onClick={() => scroll(-1)}
            tabIndex={-1}
            type="button"
          >
            <ChevronLeftIcon className="size-4 rtl:rotate-180" />
          </button>
        </>
      )}
      {state.canScrollEnd && (
        <>
          <div className="from-background pointer-events-none absolute inset-y-0 end-0 w-10 bg-linear-to-l to-transparent rtl:bg-linear-to-r" />
          <button
            aria-label={nextLabel}
            className="bg-background/90 text-foreground absolute end-1 top-1/2 -translate-y-1/2 rounded-full border p-1 shadow-sm"
            onClick={() => scroll(1)}
            tabIndex={-1}
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
