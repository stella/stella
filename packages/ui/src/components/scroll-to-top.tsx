/**
 * Scroll-to-top affordance — a subtle floating button that fades in once a
 * scroll container is scrolled past a threshold and jumps back to the top
 * (instant, not animated, so it stays snappy on very long documents).
 */

"use client";

import { type RefObject, useEffect, useState } from "react";

import { cn } from "@stll/ui/lib/utils";

export type ScrollToTopProps = {
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** Show once scrollTop exceeds this many px. */
  threshold?: number;
  label?: string;
  className?: string;
};

export const ScrollToTop = ({
  scrollContainerRef,
  threshold = 600,
  label = "Scroll to top",
  className,
}: ScrollToTopProps) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }
    const onScroll = () => setVisible(container.scrollTop > threshold);
    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, threshold]);

  return (
    <button
      aria-label={label}
      className={cn(
        "border-border bg-popover/90 text-muted-foreground hover:text-foreground absolute end-6 bottom-6 z-30 flex size-9 items-center justify-center rounded-full border shadow-md backdrop-blur transition-[opacity,transform] duration-200",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
        className,
      )}
      onClick={() =>
        scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" })
      }
      title={label}
      type="button"
    >
      <svg
        aria-hidden
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <path d="m18 15-6-6-6 6" />
      </svg>
    </button>
  );
};
