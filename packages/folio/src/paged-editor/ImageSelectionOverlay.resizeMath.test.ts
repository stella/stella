import { describe, expect, test } from "bun:test";

import { calculateNewDimensions } from "./ImageSelectionOverlay";

/**
 * Resize math for the image selection overlay:
 *  - corner handles keep the image's aspect ratio (Shift frees it)
 *  - edge handles stretch a single dimension, deliberately breaking aspect
 *  - the non-driven axis passes through unchanged and unclamped
 */
describe("calculateNewDimensions", () => {
  const W = 200;
  const H = 100; // 2:1

  test("corner handle preserves aspect ratio when locked", () => {
    const r = calculateNewDimensions("se", 100, 10, W, H, true);
    expect(r.width / r.height).toBeCloseTo(2, 5);
    expect(r.width).toBeGreaterThan(W);
    expect(r.height).toBeGreaterThan(H);
  });

  test("corner handle without aspect lock resizes only the dragged axis", () => {
    // Shift (lockAspect = false): the se corner with a pure-X drag moves width
    // only, so the aspect ratio breaks.
    const r = calculateNewDimensions("se", 100, 0, W, H, false);
    expect(r.width).toBe(300);
    expect(r.height).toBe(100);
  });

  test("east edge stretches width only (vertical delta ignored)", () => {
    const r = calculateNewDimensions("e", 80, 999, W, H, true);
    expect(r.width).toBe(280);
    expect(r.height).toBe(100);
  });

  test("west edge stretches width only, from the opposite side", () => {
    // Dragging the left edge right (positive deltaX) shrinks width.
    const r = calculateNewDimensions("w", 50, 0, W, H, true);
    expect(r.width).toBe(150);
    expect(r.height).toBe(100);
  });

  test("south edge stretches height only (horizontal delta ignored)", () => {
    const r = calculateNewDimensions("s", 999, 60, W, H, true);
    expect(r.width).toBe(200);
    expect(r.height).toBe(160);
  });

  test("north edge stretches height only, from the opposite side", () => {
    // Dragging the top edge down (positive deltaY) shrinks height.
    const r = calculateNewDimensions("n", 0, 40, W, H, true);
    expect(r.width).toBe(200);
    expect(r.height).toBe(60);
  });

  test("driven axis clamps to the [20, 2000] range", () => {
    expect(calculateNewDimensions("e", -1000, 0, W, H, true).width).toBe(20);
    expect(calculateNewDimensions("e", 5000, 0, W, H, true).width).toBe(2000);
  });

  test("non-driven axis passes through unclamped", () => {
    // Height starts far above the max but an east-edge drag must not touch it.
    const r = calculateNewDimensions("e", 50, 0, 200, 5000, true);
    expect(r.height).toBe(5000);
  });

  test("locked corner shrinks along the dominant drag axis", () => {
    // Dragging the se corner mostly inward on X (width ratio 0.5) vs barely on Y
    // (0.9): the resize must follow the dominant axis and shrink, not snap back
    // to the axis that barely moved (the old Math.max bug left it ~180x90).
    const r = calculateNewDimensions("se", -100, -10, W, H, true);
    expect(r.width).toBe(100);
    expect(r.height).toBe(50);
    expect(r.width / r.height).toBeCloseTo(2, 5);
  });

  test("locked corner clamps the scale as a whole, preserving aspect", () => {
    // A huge X drag would clamp width to 2000; clamping height independently
    // would peg it at 2000 too and square the image. Clamping the scale keeps
    // the 2:1 ratio (2000x1000).
    const r = calculateNewDimensions("se", 10_000, 0, W, H, true);
    expect(r.width).toBe(2000);
    expect(r.height).toBe(1000);
    expect(r.width / r.height).toBeCloseTo(2, 5);
  });

  test("locked corner with zero start dimensions does not produce NaN", () => {
    const r = calculateNewDimensions("se", 100, 50, 0, 0, true);
    expect(Number.isFinite(r.width)).toBe(true);
    expect(Number.isFinite(r.height)).toBe(true);
  });

  test("locked corner with an impossible aspect ratio still caps at the max", () => {
    // A 700x1 rule: the min-size (each side >= 20) and max-size (each side
    // <= 2000) constraints can't both hold while preserving aspect, so
    // minScale > maxScale. The driven dimension must still cap at the max
    // rather than running away (the bug was width -> 14000).
    const r = calculateNewDimensions("se", 100, 100, 700, 1, true);
    expect(r.width).toBeLessThanOrEqual(2000);
    expect(r.height).toBeLessThanOrEqual(2000);
  });
});
