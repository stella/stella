import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  claimsSwipe,
  SWIPE_CLOSED,
  SWIPE_REVEAL_WIDTH,
  SWIPE_SIDE,
  swipeOffset,
  swipeSettle,
} from "./swipe";
import type { SwipeRest, SwipeSettle, SwipeSide } from "./swipe";

const ROW_WIDTH = 390;

/** How far each outcome goes: closing, then showing the action, then running it. */
const REACH = { close: 0, open: 1, run: 2 } as const satisfies Record<
  SwipeSettle["type"],
  number
>;

const BOTH = [SWIPE_SIDE.leading, SWIPE_SIDE.trailing] as const;
const side = fc.constantFrom(...BOTH);
const rest = fc.oneof(
  fc.constant(SWIPE_CLOSED),
  side.map((open): SwipeRest => ({ type: "open", side: open })),
);
const sides = fc.subarray([...BOTH]);
const travel = fc.double({ max: 2000, min: -2000, noNaN: true });
const velocity = fc.double({ max: 5, min: -5, noNaN: true });
const width = fc.double({ max: 1400, min: 0, noNaN: true });

/** The side a settle shows or runs, if any. */
const settledSide = (outcome: SwipeSettle): SwipeSide | null =>
  outcome.type === "close" ? null : outcome.side;

describe("swipeable rows", () => {
  test("a full swipe runs the action and a short drag closes again", () => {
    expect(
      swipeSettle({ offset: ROW_WIDTH * 0.6, velocity: 0, width: ROW_WIDTH }),
    ).toEqual({ type: "run", side: SWIPE_SIDE.leading });
    expect(
      swipeSettle({ offset: -ROW_WIDTH * 0.6, velocity: 0, width: ROW_WIDTH }),
    ).toEqual({ type: "run", side: SWIPE_SIDE.trailing });
    expect(swipeSettle({ offset: 20, velocity: 0, width: ROW_WIDTH })).toEqual({
      type: "close",
    });
    expect(
      swipeSettle({
        offset: SWIPE_REVEAL_WIDTH,
        velocity: 0,
        width: ROW_WIDTH,
      }),
    ).toEqual({ type: "open", side: SWIPE_SIDE.leading });
  });

  test("a flick opens a row a short way open and closes an open one", () => {
    expect(swipeSettle({ offset: 20, velocity: 1, width: ROW_WIDTH })).toEqual({
      type: "open",
      side: SWIPE_SIDE.leading,
    });
    expect(
      swipeSettle({
        offset: SWIPE_REVEAL_WIDTH,
        velocity: -1,
        width: ROW_WIDTH,
      }),
    ).toEqual({ type: "close" });
    expect(
      swipeSettle({
        offset: -SWIPE_REVEAL_WIDTH,
        velocity: 1,
        width: ROW_WIDTH,
      }),
    ).toEqual({ type: "close" });
  });

  test("the row never stands open past either edge, nor towards a side with no action", () => {
    assertProperty(
      "the row never stands open past either edge, nor towards a side with no action",
      fc.property(travel, rest, sides, width, (dx, at, offered, rowWidth) => {
        const offset = swipeOffset({
          dx,
          rest: at,
          sides: offered,
          width: rowWidth,
        });
        expect(Math.abs(offset)).toBeLessThanOrEqual(rowWidth);
        if (!offered.includes(SWIPE_SIDE.leading)) {
          expect(offset).toBeLessThanOrEqual(0);
        }
        if (!offered.includes(SWIPE_SIDE.trailing)) {
          expect(offset).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  test("dragging further never does less", () => {
    assertProperty(
      "dragging further never does less",
      fc.property(
        travel,
        travel,
        velocity,
        width,
        side,
        (first, second, speed, rowWidth, towards) => {
          const sign = towards === SWIPE_SIDE.leading ? 1 : -1;
          const near = Math.min(Math.abs(first), Math.abs(second));
          const far = Math.max(Math.abs(first), Math.abs(second));
          const settle = (shown: number) =>
            REACH[
              swipeSettle({
                offset: sign * Math.min(shown, rowWidth),
                velocity: sign * speed,
                width: rowWidth,
              }).type
            ];
          expect(settle(near)).toBeLessThanOrEqual(settle(far));
        },
      ),
    );
  });

  test("letting go settles on the side the row stands towards, the same either way", () => {
    assertProperty(
      "letting go settles on the side the row stands towards, the same either way",
      fc.property(travel, velocity, width, (offset, speed, rowWidth) => {
        const outcome = swipeSettle({
          offset,
          velocity: speed,
          width: rowWidth,
        });
        const mirrored = swipeSettle({
          offset: -offset,
          velocity: -speed,
          width: rowWidth,
        });
        expect(mirrored.type).toBe(outcome.type);
        const shown = settledSide(outcome);
        if (shown !== null) {
          expect(shown).toBe(
            offset > 0 ? SWIPE_SIDE.leading : SWIPE_SIDE.trailing,
          );
          expect(settledSide(mirrored)).not.toBe(shown);
        }
      }),
    );
  });

  test("letting go runs the action exactly past half the row", () => {
    assertProperty(
      "letting go runs the action exactly past half the row",
      fc.property(
        fc.double({ max: 1400, min: 1, noNaN: true }),
        fc.double({ max: 1, min: 0, noNaN: true }),
        velocity,
        side,
        (rowWidth, share, speed, towards) => {
          const sign = towards === SWIPE_SIDE.leading ? 1 : -1;
          const outcome = swipeSettle({
            offset: sign * rowWidth * share,
            velocity: speed,
            width: rowWidth,
          });
          expect(outcome.type === "run").toBe(
            rowWidth * share >= rowWidth * 0.5,
          );
        },
      ),
    );
  });

  test("the list keeps mostly vertical drags, and a closed row a way with no action", () => {
    assertProperty(
      "the list keeps mostly vertical drags, and a closed row a way with no action",
      fc.property(travel, travel, rest, sides, (dx, dy, at, offered) => {
        const claimed = claimsSwipe({ dx, dy, rest: at, sides: offered });
        if (Math.abs(dx) <= Math.abs(dy) * 2) {
          expect(claimed).toBe(false);
        }
        const towards = dx > 0 ? SWIPE_SIDE.leading : SWIPE_SIDE.trailing;
        if (at.type === "closed" && !offered.includes(towards)) {
          expect(claimed).toBe(false);
        }
      }),
    );
    const leadingOnly = [SWIPE_SIDE.leading];
    expect(
      claimsSwipe({ dx: 40, dy: 4, rest: SWIPE_CLOSED, sides: leadingOnly }),
    ).toBe(true);
    expect(
      claimsSwipe({ dx: -40, dy: 4, rest: SWIPE_CLOSED, sides: leadingOnly }),
    ).toBe(false);
    expect(
      claimsSwipe({ dx: -40, dy: 4, rest: SWIPE_CLOSED, sides: [...BOTH] }),
    ).toBe(true);
    expect(
      claimsSwipe({
        dx: -40,
        dy: 4,
        rest: { type: "open", side: SWIPE_SIDE.leading },
        sides: leadingOnly,
      }),
    ).toBe(true);
  });
});
