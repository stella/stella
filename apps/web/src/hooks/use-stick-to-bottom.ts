import { createContext, use, useCallback, useRef, useState } from "react";
import type { RefCallback, RefObject } from "react";

import { panic } from "better-result";

// Show the scroll-to-bottom button once the user is clearly scrolled away.
const NEAR_BOTTOM_THRESHOLD_PX = 50;
// Only consider the view "pinned" (release the scroll lock, hide the button)
// when essentially at the bottom. The gap between the two thresholds is a
// hysteresis dead-band: a small scroll-up no longer releases the lock, so the
// resize observer can't yank the view back and flicker the button.
const PINNED_BOTTOM_THRESHOLD_PX = 8;

type StickToBottomContext = {
  scrollRef: RefCallback<HTMLDivElement>;
  /** The element `scrollRef` is attached to, for consumers that read or
   *  adjust scroll metrics directly (e.g. load-older anchoring and the
   *  IntersectionObserver root in the chat transcript). */
  scrollElementRef: RefObject<HTMLDivElement | null>;
  contentRef: RefCallback<HTMLDivElement>;
  isAtBottom: boolean;
  isScrollable: boolean;
  scrollToBottom: () => void;
};

export const StickToBottomContext = createContext<StickToBottomContext | null>(
  null,
);

export const useStickToBottomContext = (): StickToBottomContext => {
  const ctx = use(StickToBottomContext);
  if (!ctx) {
    panic(
      "useStickToBottomContext must be used within a StickToBottom provider",
    );
  }
  return ctx;
};

/**
 * Like {@link useStickToBottomContext} but returns null instead of
 * panicking when no provider is present. For components that may
 * render both inside a `Conversation` and inside a bespoke scroll
 * container (e.g. the file-chat overlay).
 */
export const useMaybeStickToBottomContext = (): StickToBottomContext | null =>
  use(StickToBottomContext);

/**
 * Checks whether the user is actively selecting text inside
 * the scroll container. Based on the original
 * `use-stick-to-bottom` library's `isSelecting()` logic:
 * a selection is in progress when the mouse is held down and
 * the selection range overlaps the scroll element.
 */
const isSelectingInside = (scrollEl: HTMLElement | null): boolean => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) {
    return false;
  }

  if (!scrollEl || !selection.rangeCount) {
    return false;
  }

  const ancestor = selection.getRangeAt(0).commonAncestorContainer;
  return ancestor.contains(scrollEl) || scrollEl.contains(ancestor);
};

/**
 * Minimal stick-to-bottom hook for chat UIs.
 *
 * Watches a scroll container for content resizes and keeps
 * it pinned to the bottom while the user has not scrolled
 * away. Replaces the `use-stick-to-bottom` npm package.
 *
 * Includes wheel-escape detection, text-selection awareness,
 * and rAF-synchronized ResizeObserver callbacks.
 */
export const useStickToBottom = () => {
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  /** Whether the scroll container has more content than fits the viewport. */
  const [isScrollable, setIsScrollable] = useState(false);
  /** Tracks whether the user intentionally scrolled up. */
  const userScrolledUp = useRef(false);
  /**
   * Guards against scroll-button flicker during programmatic
   * smooth scrolls. Set to `true` in `scrollToBottom()`,
   * cleared once the scroll animation reaches the bottom.
   * While active, `onScroll` skips `setIsAtBottom` updates
   * so the button does not reappear mid-animation.
   */
  const programmaticScroll = useRef(false);

  const scrollToBottom = () => {
    const el = scrollElementRef.current;
    if (!el) {
      return;
    }
    userScrolledUp.current = false;
    programmaticScroll.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setIsAtBottom(true);
  };

  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      return undefined;
    }

    scrollElementRef.current = el;
    let lastScrollTop = el.scrollTop;

    const onScroll = () => {
      const currentTop = el.scrollTop;

      // Don't treat scroll-up during text selection as escape.
      if (currentTop < lastScrollTop && !isSelectingInside(el)) {
        userScrolledUp.current = true;
      }
      lastScrollTop = currentTop;

      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom <= PINNED_BOTTOM_THRESHOLD_PX) {
        userScrolledUp.current = false;
        programmaticScroll.current = false;
      }

      // Skip isAtBottom updates during programmatic smooth
      // scrolls to prevent the scroll button from flickering.
      if (!programmaticScroll.current) {
        // Hysteresis: hide only when pinned, show only once clearly scrolled
        // away, so the state can't oscillate in the dead-band near the edge.
        setIsAtBottom((prev) =>
          prev
            ? distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX
            : distanceFromBottom <= PINNED_BOTTOM_THRESHOLD_PX,
        );
      }
    };

    /**
     * Wheel-escape detection. The browser may cancel an
     * ongoing programmatic scroll when a wheel event fires,
     * so we must escape the lock immediately on upward wheel
     * input rather than waiting for the resulting scroll
     * event. Mirrors `handleWheel` in the original library.
     */
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) {
        return;
      }
      // Only escape when the wheel targets the scroll
      // container and the content is actually scrollable.
      if (el.scrollHeight <= el.clientHeight) {
        return;
      }
      userScrolledUp.current = true;
      setIsAtBottom(false);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      scrollElementRef.current = null;
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  const contentRef = useCallback((content: HTMLDivElement | null) => {
    if (!content) {
      return undefined;
    }

    let raf = 0;
    const observer = new ResizeObserver(() => {
      // Defer to rAF to avoid layout thrashing; the
      // ResizeObserver callback fires between style
      // recalc and paint, so reading scroll metrics here
      // can force a synchronous layout. Matching the
      // original library's synchronization approach.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = scrollElementRef.current;
        if (!el) {
          return;
        }
        setIsScrollable(el.scrollHeight > el.clientHeight);
        if (userScrolledUp.current) {
          return;
        }
        if (isSelectingInside(scrollElementRef.current)) {
          return;
        }
        el.scrollTo({
          top: el.scrollHeight,
          behavior: "instant",
        });
        setIsAtBottom(true);
      });
    });

    observer.observe(content);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return {
    scrollRef,
    scrollElementRef,
    contentRef,
    isAtBottom,
    isScrollable,
    scrollToBottom,
  };
};
