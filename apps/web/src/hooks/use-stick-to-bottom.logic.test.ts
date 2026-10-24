/* oxlint-disable require-contract-domains/require-contract-domains -- Generator bounds and input kinds size simulated scroll sessions, not an API domain or limit. */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  attachFollowState,
  decideContentResize,
  followAfterScroll,
  followAfterScrollToBottomRequest,
  followAfterWheel,
  PINNED_BOTTOM_THRESHOLD_PX,
} from "@/hooks/use-stick-to-bottom.logic";
import type {
  FollowState,
  FollowTransition,
  ScrollMetrics,
} from "@/hooks/use-stick-to-bottom.logic";

const SMOOTH_SCROLL_STEP_PX = 120;

/**
 * A transcript viewport driven the way the hook drives the browser: scroll
 * offsets are clamped, every offset change dispatches a scroll event, a
 * content resize is followed by one observer frame, and user input cancels
 * a smooth scroll. `isAtBottom` and `isScrollable` are the flags the scroll
 * button reads.
 */
class TranscriptViewport {
  contentHeight: number;
  clientHeight: number;
  scrollTop = 0;
  isAtBottom = true;
  isScrollable = false;
  selecting = false;
  smoothScrollInFlight = false;
  private follow: FollowState;

  constructor(contentHeight: number, clientHeight: number) {
    this.contentHeight = contentHeight;
    this.clientHeight = clientHeight;
    this.follow = attachFollowState(this.scrollTop);
    this.frame();
  }

  get metrics(): ScrollMetrics {
    return {
      clientHeight: this.clientHeight,
      scrollHeight: Math.max(this.contentHeight, this.clientHeight),
      scrollTop: this.scrollTop,
    };
  }

  get maxScrollTop(): number {
    return this.metrics.scrollHeight - this.clientHeight;
  }

  get buttonVisible(): boolean {
    return this.isScrollable && !this.isAtBottom;
  }

  /** Scrollbar drag, touch or keyboard: no wheel event. */
  drag(deltaY: number): void {
    this.smoothScrollInFlight = false;
    this.moveTo(this.scrollTop + deltaY);
  }

  wheel(deltaY: number): void {
    this.smoothScrollInFlight = false;
    this.apply(followAfterWheel(this.follow, deltaY, this.metrics));
    this.moveTo(this.scrollTop + deltaY);
  }

  /** Content grows or shrinks (streaming, an image, a fold); the browser
   *  clamps the offset, then the resize observer's frame runs. */
  resizeContent(deltaHeight: number): void {
    this.contentHeight = Math.max(0, this.contentHeight + deltaHeight);
    this.moveTo(this.scrollTop);
    this.frame();
  }

  resizeViewport(deltaHeight: number): void {
    this.clientHeight = Math.max(80, this.clientHeight + deltaHeight);
    this.moveTo(this.scrollTop);
  }

  pressScrollToBottom(): void {
    this.follow = followAfterScrollToBottomRequest(this.follow);
    this.isAtBottom = true;
    this.smoothScrollInFlight = this.scrollTop < this.maxScrollTop;
  }

  smoothScrollStep(): void {
    if (!this.smoothScrollInFlight) {
      return;
    }
    this.moveTo(
      Math.min(this.maxScrollTop, this.scrollTop + SMOOTH_SCROLL_STEP_PX),
    );
    this.smoothScrollInFlight = this.scrollTop < this.maxScrollTop;
  }

  /** The thread switches: the provider stays, a new viewport mounts. */
  remount(contentHeight: number, scrollTop: number): void {
    this.contentHeight = contentHeight;
    this.scrollTop = Math.min(scrollTop, this.maxScrollTop);
    this.smoothScrollInFlight = false;
    this.follow = attachFollowState(this.scrollTop);
    this.isAtBottom = true;
  }

  private frame(): void {
    const decision = decideContentResize(
      this.follow,
      this.metrics,
      () => this.selecting,
    );
    this.isScrollable = decision.isScrollable;
    if (!decision.scrollToBottom) {
      return;
    }
    this.smoothScrollInFlight = false;
    this.isAtBottom = true;
    this.moveTo(this.maxScrollTop);
  }

  private moveTo(scrollTop: number): void {
    const clamped = Math.min(Math.max(0, scrollTop), this.maxScrollTop);
    if (clamped === this.scrollTop) {
      return;
    }
    this.scrollTop = clamped;
    this.apply(
      followAfterScroll(this.follow, this.metrics, () => this.selecting),
    );
  }

  private apply(transition: FollowTransition): void {
    this.follow = transition.state;
    if (transition.isAtBottom !== undefined) {
      this.isAtBottom = transition.isAtBottom;
    }
  }
}

/** A long transcript already following its end. */
const followingTranscript = (): TranscriptViewport => {
  const viewport = new TranscriptViewport(4000, 600);
  expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
  return viewport;
};

describe("following the end of the transcript", () => {
  test("follows streamed content while the reader stays at the end", () => {
    const viewport = followingTranscript();

    viewport.resizeContent(300);
    viewport.resizeContent(45);

    expect(viewport.scrollTop).toBe(4345 - 600);
    expect(viewport.buttonVisible).toBe(false);
  });

  test("pauses the moment the reader scrolls up and keeps their place while content grows", () => {
    const viewport = followingTranscript();

    viewport.drag(-40);
    const readingAt = viewport.scrollTop;
    expect(viewport.buttonVisible).toBe(true);

    viewport.resizeContent(500);

    expect(viewport.scrollTop).toBe(readingAt);
    expect(viewport.buttonVisible).toBe(true);
  });

  test("an upward wheel pauses before its scroll event arrives", () => {
    const metrics = { clientHeight: 600, scrollHeight: 4000, scrollTop: 3400 };

    const transition = followAfterWheel(attachFollowState(3400), -1, metrics);

    expect(transition.isAtBottom).toBe(false);
    expect(
      decideContentResize(transition.state, metrics, () => false)
        .scrollToBottom,
    ).toBe(false);
  });

  test("an upward wheel over content that fits the viewport changes nothing", () => {
    const state = attachFollowState(0);

    const transition = followAfterWheel(state, -120, {
      clientHeight: 600,
      scrollHeight: 600,
    });

    expect(transition).toEqual({ isAtBottom: undefined, state });
  });

  test("scrolling up while selecting text does not pause following", () => {
    const viewport = followingTranscript();
    viewport.selecting = true;

    viewport.drag(-200);
    viewport.resizeContent(100);
    // No yank while the selection is held.
    expect(viewport.scrollTop).toBe(4000 - 600 - 200);

    viewport.selecting = false;
    viewport.resizeContent(100);
    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });
});

describe("layout changes made by the app", () => {
  test("content above the view growing (an image loading) is followed, not read as a scroll", () => {
    const viewport = followingTranscript();

    viewport.resizeContent(800);

    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });

  test("content shrinking under a pinned view (a fold closing) keeps following", () => {
    const viewport = followingTranscript();

    // The browser clamps the offset upward, which arrives as a scroll-up.
    viewport.resizeContent(-700);
    expect(viewport.scrollTop).toBe(4000 - 700 - 600);
    viewport.resizeContent(250);

    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });

  test("a viewport that shrinks (the composer growing) keeps following", () => {
    const viewport = followingTranscript();

    viewport.resizeViewport(-150);
    viewport.resizeViewport(150);
    viewport.resizeContent(90);

    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });
});

describe("re-arming", () => {
  test("re-arms only once the reader's scroll lands at the bottom", () => {
    const viewport = followingTranscript();
    viewport.drag(-900);

    viewport.drag(900 - PINNED_BOTTOM_THRESHOLD_PX - 1);
    const shortOfBottom = viewport.scrollTop;
    viewport.resizeContent(200);
    expect(viewport.scrollTop).toBe(shortOfBottom);
    expect(viewport.buttonVisible).toBe(true);

    viewport.drag(viewport.maxScrollTop - viewport.scrollTop);
    viewport.resizeContent(200);
    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });

  test("a fast flick back to the bottom re-arms following", () => {
    const viewport = followingTranscript();
    viewport.drag(-2500);

    // One large event the browser clamps at the end.
    viewport.wheel(10_000);
    viewport.resizeContent(150);

    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });

  test("the button keeps itself hidden through its own smooth scroll and re-arms following", () => {
    const viewport = followingTranscript();
    viewport.drag(-1000);

    viewport.pressScrollToBottom();
    while (viewport.smoothScrollInFlight) {
      viewport.smoothScrollStep();
      expect(viewport.buttonVisible).toBe(false);
    }
    viewport.resizeContent(120);

    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });

  test.each(["drag", "wheel"] as const)(
    "a reader who interrupts the button's smooth scroll by %s sees the button again",
    (input) => {
      const viewport = followingTranscript();
      viewport.drag(-1500);
      viewport.pressScrollToBottom();
      viewport.smoothScrollStep();
      viewport.smoothScrollStep();
      const before = viewport.scrollTop;

      viewport[input](-300);
      expect(viewport.scrollTop).toBeLessThan(before);
      viewport.resizeContent(200);

      expect(viewport.scrollTop).toBe(before - 300);
      expect(viewport.buttonVisible).toBe(true);
    },
  );
});

describe("a new viewport after a thread switch", () => {
  test("starts pinned and measures scrolls from its own offset, not the previous one", () => {
    const viewport = followingTranscript();
    viewport.drag(-3000);
    expect(viewport.buttonVisible).toBe(true);

    viewport.remount(5000, 0);
    expect(viewport.buttonVisible).toBe(false);
    // A downward scroll on the new element must not compare against the
    // old element's larger offset and read as a scroll-up.
    viewport.drag(50);
    viewport.resizeContent(100);

    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.buttonVisible).toBe(false);
  });
});

type ViewportEvent =
  | { readonly kind: "drag" | "wheel"; readonly deltaY: number }
  | { readonly kind: "content" | "viewport"; readonly deltaHeight: number }
  | { readonly kind: "select"; readonly on: boolean }
  | { readonly kind: "press" | "step" };

const viewportEvent: fc.Arbitrary<ViewportEvent> = fc.oneof(
  fc.record({
    deltaY: fc.integer({ max: 1500, min: -1500 }),
    kind: fc.constantFrom("drag" as const, "wheel" as const),
  }),
  fc.record({
    deltaHeight: fc.integer({ max: 900, min: -600 }),
    kind: fc.constant("content" as const),
  }),
  fc.record({
    deltaHeight: fc.integer({ max: 200, min: -200 }),
    kind: fc.constant("viewport" as const),
  }),
  fc.record({ kind: fc.constant("select" as const), on: fc.boolean() }),
  fc.record({ kind: fc.constantFrom("press" as const, "step" as const) }),
);

describe("random reading sessions", () => {
  test("the button shows exactly while following is paused, and only a paused reader is left in place", () => {
    assertProperty(
      "the button shows exactly while following is paused, and only a paused reader is left in place",
      fc.property(
        fc.integer({ max: 6000, min: 0 }),
        fc.integer({ max: 900, min: 200 }),
        fc.array(viewportEvent, { maxLength: 60, size: "max" }),
        (contentHeight, clientHeight, events) => {
          const viewport = new TranscriptViewport(contentHeight, clientHeight);
          // Reference: the reader pauses following by scrolling up (not
          // while selecting) or wheeling up over scrollable content, and
          // resumes it by landing at the bottom or pressing the button.
          let paused = false;
          const landedAtBottom = () =>
            viewport.maxScrollTop - viewport.scrollTop <=
            PINNED_BOTTOM_THRESHOLD_PX;

          for (const event of events) {
            const before = viewport.scrollTop;
            switch (event.kind) {
              case "drag":
              case "wheel": {
                const scrollable = viewport.maxScrollTop > 0;
                viewport[event.kind](event.deltaY);
                if (
                  (event.kind === "wheel" && event.deltaY < 0 && scrollable) ||
                  (viewport.scrollTop < before && !viewport.selecting)
                ) {
                  paused = true;
                }
                break;
              }
              case "content": {
                viewport.resizeContent(event.deltaHeight);
                const clampedTo = Math.min(before, viewport.maxScrollTop);
                if (paused || viewport.selecting) {
                  // Left in place, apart from the browser's clamp.
                  expect(viewport.scrollTop).toBe(clampedTo);
                } else {
                  expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
                }
                break;
              }
              case "viewport":
                viewport.resizeViewport(event.deltaHeight);
                break;
              case "select":
                viewport.selecting = event.on;
                break;
              case "press":
                if (viewport.buttonVisible) {
                  viewport.pressScrollToBottom();
                  paused = false;
                }
                break;
              case "step":
                viewport.smoothScrollStep();
                break;
              default:
                event satisfies never;
            }
            if (viewport.scrollTop !== before && landedAtBottom()) {
              paused = false;
            }
            expect(viewport.isAtBottom).toBe(!paused);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
