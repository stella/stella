/**
 * Scroll-to-top affordance — a subtle floating button that fades in once a
 * scroll container is scrolled past a threshold and jumps back to the top
 * (instant, not animated, so it stays snappy on very long documents).
 */

"use client";

import { type RefObject, useState } from "react";

import { useObservedValue } from "../effects/dom";
import { useLatestCallback } from "../effects/effects";
import { containedEventHandler } from "../hooks/use-contained-handler";
import { cn } from "../lib/utils";

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
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  // The scroll container is the caller's; the button owns the subscription,
  // so it runs once both have mounted.
  const visible = useObservedValue<HTMLButtonElement, boolean>(
    button,
    (_button, emit) => {
      const container = scrollContainerRef.current;
      if (!container) {
        return () => undefined;
      }
      const onScroll = () => emit(container.scrollTop > threshold);
      onScroll();
      container.addEventListener("scroll", onScroll, { passive: true });
      return () => container.removeEventListener("scroll", onScroll);
    },
    [scrollContainerRef, threshold],
    false,
  );

  const scrollToTop = useLatestCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
  });

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
      onClick={containedEventHandler(scrollToTop)}
      ref={setButton}
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
