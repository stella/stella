import { createContext, use, useCallback, useRef, useState } from "react";
import type { RefCallback, RefObject } from "react";

import { panic } from "better-result";

import {
  attachFollowState,
  decideContentResize,
  followAfterScroll,
  followAfterScrollToBottomRequest,
  followAfterWheel,
} from "@/hooks/use-stick-to-bottom.logic";
import type {
  FollowState,
  FollowTransition,
} from "@/hooks/use-stick-to-bottom.logic";

type StickToBottomContextValue = {
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

export const StickToBottomContext =
  createContext<StickToBottomContextValue | null>(null);

export const useStickToBottomContext = (): StickToBottomContextValue => {
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
export const useMaybeStickToBottomContext =
  (): StickToBottomContextValue | null => use(StickToBottomContext);

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
  /** Escape state of the attached element; the transitions live in
   *  `use-stick-to-bottom.logic.ts`. */
  const followState = useRef<FollowState>(attachFollowState(0));

  const scrollToBottom = () => {
    const el = scrollElementRef.current;
    if (!el) {
      return;
    }
    followState.current = followAfterScrollToBottomRequest(followState.current);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setIsAtBottom(true);
  };

  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      return undefined;
    }

    scrollElementRef.current = el;
    // The escape state belongs to the scroll element, not the provider. The
    // provider outlives a thread switch (the chat page keeps one instance
    // across `/chat/$threadId` navigations, and its composer reads this
    // context), so a freshly mounted viewport must start pinned; otherwise
    // a scroll-up in the previous thread would carry over and the new
    // transcript would land wherever the old scroll offset happened to be.
    followState.current = attachFollowState(el.scrollTop);
    // The observable state moves with the refs: the content observer would
    // restore it a frame later, but until then `isScrollable && !isAtBottom`
    // can flash the scroll button over a transcript that is already pinned.
    setIsAtBottom(true);

    const applyTransition = (transition: FollowTransition) => {
      followState.current = transition.state;
      if (transition.isAtBottom !== undefined) {
        setIsAtBottom(transition.isAtBottom);
      }
    };

    const onScroll = () => {
      applyTransition(
        followAfterScroll(followState.current, el, () => isSelectingInside(el)),
      );
    };

    // Wheel-escape detection, mirroring `handleWheel` in the original
    // library: see `followAfterWheel`.
    const onWheel = (event: WheelEvent) => {
      applyTransition(followAfterWheel(followState.current, event.deltaY, el));
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
        const decision = decideContentResize(followState.current, el, () =>
          isSelectingInside(el),
        );
        setIsScrollable(decision.isScrollable);
        if (!decision.scrollToBottom) {
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
