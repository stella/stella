import { describe, expect, test } from "bun:test";

import { resolveFacetOverflow } from "./facet-bar.logic";

const CHIP_WIDTHS = [50, 50, 50, 50];
const GAP = 10;
const TRIGGER_WIDTH = 40;

describe("resolveFacetOverflow", () => {
  test("all fit: every chip is visible and the trigger stays hidden", () => {
    const policy = resolveFacetOverflow({
      activeIndex: 0,
      availableWidth: 250,
      chipWidths: CHIP_WIDTHS,
      gap: GAP,
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 4, showOverflowTrigger: false });
  });

  test("some overflow: the active chip already sits in the fitting prefix", () => {
    // width 150 only fits chip 0 alongside the trigger; the active chip
    // (index 0) is already inside that prefix, so no re-pin is needed.
    const policy = resolveFacetOverflow({
      activeIndex: 0,
      availableWidth: 150,
      chipWidths: CHIP_WIDTHS,
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
    const policy = resolveFacetOverflow({
      activeIndex: 3,
      availableWidth: 200,
      chipWidths: CHIP_WIDTHS,
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
    const policy = resolveFacetOverflow({
      activeIndex: 2,
      availableWidth: 80,
      chipWidths: CHIP_WIDTHS,
      gap: GAP,
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 0, showOverflowTrigger: true });
  });

  test("gap defaults to zero when omitted", () => {
    const policy = resolveFacetOverflow({
      activeIndex: 0,
      availableWidth: 200,
      chipWidths: [50, 50, 50, 50],
      triggerWidth: TRIGGER_WIDTH,
    });

    expect(policy).toEqual({ visibleCount: 4, showOverflowTrigger: false });
  });
});
