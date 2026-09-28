import { describe, expect, test } from "bun:test";

import {
  adjustStampBox,
  canPlaceStamp,
  defaultStampBox,
  previewDeltaToPoints,
  STAMP_LIMITS_PT,
  stampKeyAdjustment,
  type StampBox,
  type StampPageSize,
} from "@/components/inspector/pdf-signing-stamp.logic";

const A4_PORTRAIT = { height: 841.89, width: 595.28 } as const;
// An A4 page with /Rotate 90 displays with its sides swapped.
const A4_LANDSCAPE = { height: 595.28, width: 841.89 } as const;

const inPoints = (box: StampBox, page: StampPageSize) => ({
  height: box.height * page.height,
  width: box.width * page.width,
  x: box.x * page.width,
  y: box.y * page.height,
});

const expectPoints = (
  box: StampBox,
  page: StampPageSize,
  expected: { height: number; width: number; x: number; y: number },
) => {
  const points = inPoints(box, page);
  expect(points.x).toBeCloseTo(expected.x, 6);
  expect(points.y).toBeCloseTo(expected.y, 6);
  expect(points.width).toBeCloseTo(expected.width, 6);
  expect(points.height).toBeCloseTo(expected.height, 6);
};

describe("default stamp placement", () => {
  test("sits in the bottom-right corner of a portrait page with a margin", () => {
    expectPoints(defaultStampBox(A4_PORTRAIT), A4_PORTRAIT, {
      height: 60,
      width: 200,
      x: 595.28 - 200 - 36,
      y: 841.89 - 60 - 36,
    });
  });

  test("follows the displayed orientation of a rotated page", () => {
    expectPoints(defaultStampBox(A4_LANDSCAPE), A4_LANDSCAPE, {
      height: 60,
      width: 200,
      x: 841.89 - 200 - 36,
      y: 595.28 - 60 - 36,
    });
  });

  test("shrinks to fit a page smaller than the default stamp", () => {
    const page = { height: 50, width: 150 };
    expectPoints(defaultStampBox(page), page, {
      height: 50,
      width: 150,
      x: 0,
      y: 0,
    });
  });
});

describe("stamp adjustment", () => {
  test("converts a preview drag into page points by the render scale", () => {
    // The page is drawn at half size, so one pixel covers two points.
    const preview = { height: 841.89 / 2, width: 595.28 / 2 };
    expect(
      previewDeltaToPoints({
        delta: { x: 10, y: -5 },
        page: A4_PORTRAIT,
        preview,
      }),
    ).toEqual({ x: 20, y: -10 });
  });

  test("moves the box without changing its size", () => {
    const start = defaultStampBox(A4_PORTRAIT);
    const moved = adjustStampBox({
      box: start,
      deltaPt: { x: -100, y: -200 },
      mode: "move",
      page: A4_PORTRAIT,
    });
    expectPoints(moved, A4_PORTRAIT, {
      height: 60,
      width: 200,
      x: 595.28 - 200 - 36 - 100,
      y: 841.89 - 60 - 36 - 200,
    });
  });

  test("stops a move at the page edges", () => {
    const start = defaultStampBox(A4_PORTRAIT);
    const pastBottomRight = adjustStampBox({
      box: start,
      deltaPt: { x: 5000, y: 5000 },
      mode: "move",
      page: A4_PORTRAIT,
    });
    expectPoints(pastBottomRight, A4_PORTRAIT, {
      height: 60,
      width: 200,
      x: 595.28 - 200,
      y: 841.89 - 60,
    });

    const pastTopLeft = adjustStampBox({
      box: start,
      deltaPt: { x: -5000, y: -5000 },
      mode: "move",
      page: A4_PORTRAIT,
    });
    expectPoints(pastTopLeft, A4_PORTRAIT, {
      height: 60,
      width: 200,
      x: 0,
      y: 0,
    });
  });

  test("resizes from the bottom-right corner, keeping the top-left fixed", () => {
    const start = defaultStampBox(A4_PORTRAIT);
    const grown = adjustStampBox({
      box: start,
      deltaPt: { x: 20, y: 30 },
      mode: "resize",
      page: A4_PORTRAIT,
    });
    expectPoints(grown, A4_PORTRAIT, {
      height: 90,
      width: 220,
      x: 595.28 - 200 - 36,
      y: 841.89 - 60 - 36,
    });
  });

  test("keeps a resize within the minimum and maximum size", () => {
    const topLeft = { height: 60 / 841.89, width: 200 / 595.28, x: 0, y: 0 };
    expectPoints(
      adjustStampBox({
        box: topLeft,
        deltaPt: { x: -1000, y: -1000 },
        mode: "resize",
        page: A4_PORTRAIT,
      }),
      A4_PORTRAIT,
      {
        height: STAMP_LIMITS_PT.minHeight,
        width: STAMP_LIMITS_PT.minWidth,
        x: 0,
        y: 0,
      },
    );
    expectPoints(
      adjustStampBox({
        box: topLeft,
        deltaPt: { x: 1000, y: 1000 },
        mode: "resize",
        page: A4_PORTRAIT,
      }),
      A4_PORTRAIT,
      {
        height: STAMP_LIMITS_PT.maxHeight,
        width: STAMP_LIMITS_PT.maxWidth,
        x: 0,
        y: 0,
      },
    );
  });

  test("stops a resize at the page edge instead of pushing the box", () => {
    const start = defaultStampBox(A4_PORTRAIT);
    const grown = adjustStampBox({
      box: start,
      deltaPt: { x: 150, y: 150 },
      mode: "resize",
      page: A4_PORTRAIT,
    });
    // Only the 36pt margin was free on the right and at the bottom.
    expectPoints(grown, A4_PORTRAIT, {
      height: 60 + 36,
      width: 200 + 36,
      x: 595.28 - 200 - 36,
      y: 841.89 - 60 - 36,
    });
  });

  test("pulls an out-of-range box back onto the page", () => {
    const oversized = { height: 0.5, width: 1.2, x: 0.9, y: -0.1 };
    expectPoints(
      adjustStampBox({
        box: oversized,
        deltaPt: { x: 0, y: 0 },
        mode: "move",
        page: A4_PORTRAIT,
      }),
      A4_PORTRAIT,
      {
        height: STAMP_LIMITS_PT.maxHeight,
        width: STAMP_LIMITS_PT.maxWidth,
        x: 595.28 - STAMP_LIMITS_PT.maxWidth,
        y: 0,
      },
    );
  });

  test("any sequence of adjustments stays on the page and within limits", () => {
    // Deterministic pseudo-random walk over both page orientations.
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const epsilon = 1e-9;

    for (const page of [A4_PORTRAIT, A4_LANDSCAPE]) {
      let box = defaultStampBox(page);
      for (let step = 0; step < 500; step++) {
        box = adjustStampBox({
          box,
          deltaPt: { x: (random() - 0.5) * 600, y: (random() - 0.5) * 600 },
          mode: random() < 0.5 ? "move" : "resize",
          page,
        });
        const points = inPoints(box, page);
        expect(points.x).toBeGreaterThanOrEqual(-epsilon);
        expect(points.y).toBeGreaterThanOrEqual(-epsilon);
        expect(points.x + points.width).toBeLessThanOrEqual(
          page.width + epsilon,
        );
        expect(points.y + points.height).toBeLessThanOrEqual(
          page.height + epsilon,
        );
        expect(points.width).toBeGreaterThanOrEqual(
          STAMP_LIMITS_PT.minWidth - epsilon,
        );
        expect(points.width).toBeLessThanOrEqual(
          STAMP_LIMITS_PT.maxWidth + epsilon,
        );
        expect(points.height).toBeGreaterThanOrEqual(
          STAMP_LIMITS_PT.minHeight - epsilon,
        );
        expect(points.height).toBeLessThanOrEqual(
          STAMP_LIMITS_PT.maxHeight + epsilon,
        );
      }
    }
  });
});

describe("stamp keyboard control", () => {
  test("arrow keys move and Shift with an arrow key resizes", () => {
    expect(stampKeyAdjustment({ key: "ArrowLeft", shiftKey: false })).toEqual({
      deltaPt: { x: -4, y: 0 },
      mode: "move",
    });
    expect(stampKeyAdjustment({ key: "ArrowDown", shiftKey: true })).toEqual({
      deltaPt: { x: 0, y: 4 },
      mode: "resize",
    });
  });

  test("other keys leave the box alone", () => {
    expect(stampKeyAdjustment({ key: "Enter", shiftKey: false })).toBeNull();
    expect(stampKeyAdjustment({ key: "toString", shiftKey: false })).toBeNull();
  });
});

describe("stamp availability", () => {
  test("needs a page at least as large as the smallest stamp", () => {
    expect(canPlaceStamp(A4_PORTRAIT)).toBe(true);
    expect(canPlaceStamp({ height: 200, width: 60 })).toBe(false);
    expect(canPlaceStamp({ height: 20, width: 200 })).toBe(false);
  });
});
