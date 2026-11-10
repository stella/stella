import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  claimsSwipe,
  SWIPE_REVEAL_WIDTH,
  swipeOffset,
  swipeSettle,
} from "./swipe";
import type { SwipeSettle } from "./swipe";

const ROW_WIDTH = 390;

/** How far each outcome goes: closing, then showing the action, then running it. */
const REACH = { close: 0, open: 1, run: 2 } as const satisfies Record<
  SwipeSettle,
  number
>;

const rest = fc.constantFrom("closed" as const, "open" as const);
const travel = fc.double({ max: 2000, min: -2000, noNaN: true });
const velocity = fc.double({ max: 5, min: -5, noNaN: true });
const width = fc.double({ max: 1400, min: 0, noNaN: true });

describe("swipeable rows", () => {
  test("a full swipe runs the action and a short drag closes again", () => {
    expect(
      swipeSettle({ offset: ROW_WIDTH * 0.6, velocity: 0, width: ROW_WIDTH }),
    ).toBe("run");
    expect(swipeSettle({ offset: 20, velocity: 0, width: ROW_WIDTH })).toBe(
      "close",
    );
    expect(
      swipeSettle({
        offset: SWIPE_REVEAL_WIDTH,
        velocity: 0,
        width: ROW_WIDTH,
      }),
    ).toBe("open");
  });

  test("a flick opens a row a short way open and closes an open one", () => {
    expect(swipeSettle({ offset: 20, velocity: 1, width: ROW_WIDTH })).toBe(
      "open",
    );
    expect(
      swipeSettle({
        offset: SWIPE_REVEAL_WIDTH,
        velocity: -1,
        width: ROW_WIDTH,
      }),
    ).toBe("close");
  });

  test("the row never stands open past either edge", () => {
    assertProperty(
      "the row never stands open past either edge",
      fc.property(travel, rest, width, (dx, at, rowWidth) => {
        const offset = swipeOffset({ dx, rest: at, width: rowWidth });
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThanOrEqual(rowWidth);
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
        (first, second, speed, rowWidth) => {
          const near = Math.min(Math.abs(first), Math.abs(second));
          const far = Math.max(Math.abs(first), Math.abs(second));
          const settle = (offset: number) =>
            REACH[
              swipeSettle({
                offset: Math.min(offset, rowWidth),
                velocity: speed,
                width: rowWidth,
              })
            ];
          expect(settle(near)).toBeLessThanOrEqual(settle(far));
        },
      ),
    );
  });

  test("letting go runs the action exactly past half the row", () => {
    assertProperty(
      "letting go runs the action exactly past half the row",
      fc.property(
        fc.double({ max: 1400, min: 1, noNaN: true }),
        fc.double({ max: 1, min: 0, noNaN: true }),
        velocity,
        (rowWidth, share, speed) => {
          const outcome = swipeSettle({
            offset: rowWidth * share,
            velocity: speed,
            width: rowWidth,
          });
          expect(outcome === "run").toBe(rowWidth * share >= rowWidth * 0.5);
        },
      ),
    );
  });

  test("the list keeps mostly vertical drags, and a closed row the wrong way", () => {
    assertProperty(
      "the list keeps mostly vertical drags, and a closed row the wrong way",
      fc.property(travel, travel, rest, (dx, dy, at) => {
        const claimed = claimsSwipe({ dx, dy, rest: at });
        if (Math.abs(dx) <= Math.abs(dy) * 2) {
          expect(claimed).toBe(false);
        }
        if (at === "closed" && dx <= 0) {
          expect(claimed).toBe(false);
        }
      }),
    );
    expect(claimsSwipe({ dx: 40, dy: 4, rest: "closed" })).toBe(true);
    expect(claimsSwipe({ dx: -40, dy: 4, rest: "open" })).toBe(true);
  });
});
