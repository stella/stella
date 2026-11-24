import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { resolveInlineOverflow, splitInlineOverflow } from "./inline-overflow";

const CHIP_WIDTHS = [50, 50, 50, 50];
const GAP = 10;
const TRIGGER_WIDTH = 40;

describe("resolveInlineOverflow", () => {
  test("all fit: every chip is visible and the trigger stays hidden", () => {
    const policy = resolveInlineOverflow({
      activeIndex: 0,
      availableWidth: 250,
      itemWidths: CHIP_WIDTHS,
      gap: GAP,
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 4, showOverflowTrigger: false });
  });

  test("some overflow: the active chip already sits in the fitting prefix", () => {
    // width 150 only fits chip 0 alongside the trigger; the active chip
    // (index 0) is already inside that prefix, so no re-pin is needed.
    const policy = resolveInlineOverflow({
      activeIndex: 0,
      availableWidth: 150,
      itemWidths: CHIP_WIDTHS,
      gap: GAP,
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 1, showOverflowTrigger: true });
  });

  test("active chip pinned visible: it falls outside the naive prefix but is kept on screen", () => {
    // The naive left-to-right pass only fits chips 0 and 1 (count 2), so
    // the active chip at index 3 would be dropped by a plain prefix cut.
    // The policy re-counts with the active chip's width reserved first
    // instead, fitting chip 0 alongside it (2 total) rather than
    // silently hiding the active facet.
    const policy = resolveInlineOverflow({
      activeIndex: 3,
      availableWidth: 200,
      itemWidths: CHIP_WIDTHS,
      gap: GAP,
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 2, showOverflowTrigger: true });
  });

  test("narrow width keeps the trigger reachable: nothing but the trigger shows", () => {
    // Even the active chip alone (50) plus its gap (10) and the trigger
    // (40) — 100 — does not fit in 80. Showing the active chip anyway
    // would push the trigger past `availableWidth`, and the row clips
    // overflow: the trigger, the only way to reach any facet, would be
    // unreachable. The policy drops the active chip instead so the
    // trigger — and, through its menu, every facet — stays reachable.
    const policy = resolveInlineOverflow({
      activeIndex: 2,
      availableWidth: 80,
      itemWidths: CHIP_WIDTHS,
      gap: GAP,
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 0, showOverflowTrigger: true });
  });

  test("gap defaults to zero when omitted", () => {
    const policy = resolveInlineOverflow({
      activeIndex: 0,
      availableWidth: 200,
      itemWidths: [50, 50, 50, 50],
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 4, showOverflowTrigger: false });
  });
});

describe("splitInlineOverflow", () => {
  const ITEMS = ["a", "b", "c", "d"] as const;

  test("a prefix stays visible when the active item is inside it", () => {
    expect(splitInlineOverflow(ITEMS, 2, 1)).toEqual({
      visible: ["a", "b"],
      overflow: ["c", "d"],
    });
  });

  test("an active item past the prefix takes the last visible slot", () => {
    expect(splitInlineOverflow(ITEMS, 2, 3)).toEqual({
      visible: ["a", "d"],
      overflow: ["b", "c"],
    });
  });

  test("the narrow floor lists every item in the menu", () => {
    expect(splitInlineOverflow(ITEMS, 0, 2)).toEqual({
      visible: [],
      overflow: ["a", "b", "c", "d"],
    });
  });
});

describe("inline overflow invariants", () => {
  const row = fc.record({
    widths: fc.array(fc.integer({ min: 1, max: 200 }), {
      minLength: 1,
      maxLength: 12,
    }),
    availableWidth: fc.integer({ min: 0, max: 1200 }),
    triggerWidth: fc.integer({ min: 1, max: 60 }),
    gap: fc.integer({ min: 0, max: 12 }),
    activeSeed: fc.nat(),
  });

  test("every item is shown or listed once, and what shows fits", () => {
    assertProperty(
      "every item is shown or listed once, and what shows fits",
      fc.property(
        row,
        ({ widths, availableWidth, triggerWidth, gap, activeSeed }) => {
          const activeIndex = activeSeed % widths.length;
          const policy = resolveInlineOverflow({
            activeIndex,
            availableWidth,
            gap,
            itemWidths: widths,
            triggerWidth,
          });
          const indexes = widths.map((_, index) => index);
          const { visible, overflow } = splitInlineOverflow(
            indexes,
            policy.visibleCount,
            activeIndex,
          );

          expect([...visible, ...overflow].toSorted((a, b) => a - b)).toEqual(
            indexes,
          );
          expect(policy.showOverflowTrigger).toBe(overflow.length > 0);
          if (visible.length > 0 && overflow.length > 0) {
            expect(visible).toContain(activeIndex);
          }
          const shown = visible.reduce(
            (sum, index, position) =>
              sum + (widths[index] ?? 0) + (position > 0 ? gap : 0),
            0,
          );
          const reserved = policy.showOverflowTrigger
            ? (visible.length > 0 ? gap : 0) + triggerWidth
            : 0;
          if (visible.length > 0) {
            expect(shown + reserved).toBeLessThanOrEqual(availableWidth);
          }
        },
      ),
    );
  });
});
