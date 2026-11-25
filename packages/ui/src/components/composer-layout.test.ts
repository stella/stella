import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  composerLayoutOf,
  composerLayoutStart,
  type ComposerLayoutState,
  withDraftEmptiness,
  withTextHeight,
} from "./composer-layout";
import { COMPOSER_NATIVE_LINE_HEIGHT } from "./composer-tokens";

// Heights as a phone lays the composer's text out: one 24pt line, two.
const LINE = COMPOSER_NATIVE_LINE_HEIGHT;
const ONE_LINE = LINE;
const TWO_LINES = LINE * 2;

/** Typing into a compact frame: the draft's text, then its laid-out height. */
const typed = (
  state: ComposerLayoutState,
  draft: string,
  height: number,
): ComposerLayoutState =>
  withTextHeight(withDraftEmptiness(state, draft.trim() === ""), height, LINE);

describe("compact composer layout", () => {
  test("is a bar while empty and while the text fits one line", () => {
    let state = composerLayoutStart(true);
    expect(composerLayoutOf("compact", state)).toBe("bar");
    state = typed(state, "Summarise the lease", ONE_LINE);
    expect(composerLayoutOf("compact", state)).toBe("bar");
  });

  test("stacks the first time the text needs a second line", () => {
    const oneLine = typed(composerLayoutStart(true), "Summarise", ONE_LINE);
    expect(composerLayoutOf("compact", oneLine)).toBe("bar");
    const wrapped = typed(oneLine, "Summarise the lease and list", TWO_LINES);
    expect(composerLayoutOf("compact", wrapped)).toBe("stacked");
  });

  test("a line break counts like a wrap: the height decides, not the text", () => {
    const broken = typed(composerLayoutStart(true), "a\nb", TWO_LINES);
    expect(composerLayoutOf("compact", broken)).toBe("stacked");
    // A long draft that still lays out on one line stays a bar.
    const long = typed(composerLayoutStart(true), "x".repeat(400), ONE_LINE);
    expect(composerLayoutOf("compact", long)).toBe("bar");
  });

  test("stays stacked when the text is shortened back to one line", () => {
    let state = typed(composerLayoutStart(true), "two\nlines", TWO_LINES);
    state = typed(state, "two", ONE_LINE);
    expect(composerLayoutOf("compact", state)).toBe("stacked");
  });

  test("goes back to the bar only once the draft is empty", () => {
    let state = typed(composerLayoutStart(true), "two\nlines", TWO_LINES);
    state = typed(state, "t", ONE_LINE);
    expect(composerLayoutOf("compact", state)).toBe("stacked");
    state = typed(state, "", ONE_LINE);
    expect(composerLayoutOf("compact", state)).toBe("bar");
    // And the next draft starts over as a bar.
    state = typed(state, "next", ONE_LINE);
    expect(composerLayoutOf("compact", state)).toBe("bar");
  });

  test("a draft of blank lines is empty yet stays stacked while tall", () => {
    let state = typed(composerLayoutStart(true), "\n\n", TWO_LINES * 2);
    expect(composerLayoutOf("compact", state)).toBe("stacked");
    // Reporting the same emptiness again does not reset it.
    state = withDraftEmptiness(state, true);
    expect(composerLayoutOf("compact", state)).toBe("stacked");
  });

  test("a frame that mounts with a long draft stacks on its first height", () => {
    const state = withTextHeight(composerLayoutStart(false), TWO_LINES, LINE);
    expect(composerLayoutOf("compact", state)).toBe("stacked");
  });
});

test("a large composer is always stacked", () => {
  expect(composerLayoutOf("large", composerLayoutStart(true))).toBe("stacked");
  expect(
    composerLayoutOf("large", typed(composerLayoutStart(true), "a", ONE_LINE)),
  ).toBe("stacked");
});

/** One thing a composer's frame hears: the draft's emptiness, or a height. */
type FrameEvent =
  | { readonly kind: "empty"; readonly empty: boolean }
  | { readonly kind: "height"; readonly lines: number };

const frameEvent: fc.Arbitrary<FrameEvent> = fc.oneof(
  fc.record({ kind: fc.constant("empty" as const), empty: fc.boolean() }),
  fc.record({
    kind: fc.constant("height" as const),
    lines: fc.double({ min: 0, max: 20, noNaN: true }),
  }),
);

const apply = (
  state: ComposerLayoutState,
  event: FrameEvent,
): ComposerLayoutState =>
  event.kind === "empty"
    ? withDraftEmptiness(state, event.empty)
    : withTextHeight(state, event.lines * LINE, LINE);

test("a compact frame switches only on a second line or an emptied draft", () => {
  assertProperty(
    "a compact frame switches only on a second line or an emptied draft",
    fc.property(fc.boolean(), fc.array(frameEvent), (startEmpty, events) => {
      let state = composerLayoutStart(startEmpty);
      for (const event of events) {
        const before = composerLayoutOf("compact", state);
        const next = apply(state, event);
        const after = composerLayoutOf("compact", next);
        if (before === "bar" && after === "stacked") {
          // Only a height past one and a half lines stacks a bar.
          expect(event.kind === "height" && event.lines > 1.5).toBe(true);
        }
        if (before === "stacked" && after === "bar") {
          // Only the draft becoming empty brings the bar back.
          expect(event.kind === "empty" && event.empty && !state.empty).toBe(
            true,
          );
        }
        state = next;
      }
    }),
  );
});
