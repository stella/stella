import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  adjustStampBox,
  canPlaceStamp,
  defaultStampBox,
  drawnStampBox,
  type PagePoint,
  previewDeltaToPoints,
  settleDrawnStampBox,
  STAMP_LIMITS_PT,
  type StampBox,
  stampKeyAdjustment,
  type StampPageSize,
  stampSizeCheck,
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

const EPSILON = 1e-6;

const expectSameBox = (actual: StampBox | null, expected: StampBox) => {
  expect(actual).not.toBeNull();
  expect(actual?.x ?? Number.NaN).toBeCloseTo(expected.x, 6);
  expect(actual?.y ?? Number.NaN).toBeCloseTo(expected.y, 6);
  expect(actual?.width ?? Number.NaN).toBeCloseTo(expected.width, 6);
  expect(actual?.height ?? Number.NaN).toBeCloseTo(expected.height, 6);
};

const expectWithinPageAndLimits = (box: StampBox, page: StampPageSize) => {
  const points = inPoints(box, page);
  expect(points.x).toBeGreaterThanOrEqual(-EPSILON);
  expect(points.y).toBeGreaterThanOrEqual(-EPSILON);
  expect(points.x + points.width).toBeLessThanOrEqual(page.width + EPSILON);
  expect(points.y + points.height).toBeLessThanOrEqual(page.height + EPSILON);
  expect(stampSizeCheck(box, page)).toBe("fits");
};

/** A point on an A4 portrait page, given in points from its top-left corner. */
const at = (x: number, y: number): PagePoint => ({
  x: x / A4_PORTRAIT.width,
  y: y / A4_PORTRAIT.height,
});

describe("drawing a stamp on the page", () => {
  test("spans the drag in whichever direction it went", () => {
    const forward = drawnStampBox({
      anchor: at(100, 200),
      current: at(300, 260),
    });
    const backward = drawnStampBox({
      anchor: at(300, 260),
      current: at(100, 200),
    });
    expect(backward).toEqual(forward);
    expectPoints(forward, A4_PORTRAIT, {
      height: 60,
      width: 200,
      x: 100,
      y: 200,
    });
  });

  test("cuts a drag that leaves the page at the page edge", () => {
    expectPoints(
      drawnStampBox({ anchor: at(500, 800), current: { x: 1.4, y: 1.2 } }),
      A4_PORTRAIT,
      { height: 841.89 - 800, width: 595.28 - 500, x: 500, y: 800 },
    );
  });

  test("tells a box inside the size limits from one outside them", () => {
    const sized = (width: number, height: number) =>
      stampSizeCheck(
        drawnStampBox({ anchor: at(0, 0), current: at(width, height) }),
        A4_PORTRAIT,
      );
    expect(sized(STAMP_LIMITS_PT.minWidth, STAMP_LIMITS_PT.minHeight)).toBe(
      "fits",
    );
    expect(sized(STAMP_LIMITS_PT.maxWidth, STAMP_LIMITS_PT.maxHeight)).toBe(
      "fits",
    );
    expect(sized(STAMP_LIMITS_PT.minWidth - 1, 100)).toBe("too_small");
    expect(sized(200, STAMP_LIMITS_PT.minHeight - 1)).toBe("too_small");
    expect(sized(STAMP_LIMITS_PT.maxWidth + 1, 100)).toBe("too_large");
    expect(sized(200, STAMP_LIMITS_PT.maxHeight + 1)).toBe("too_large");
  });

  test("a click places a default stamp with its corner at the click", () => {
    const box = settleDrawnStampBox({
      anchor: at(120, 300),
      current: at(122, 301),
      page: A4_PORTRAIT,
    });
    expect(box).not.toBeNull();
    expectPoints(box ?? defaultStampBox(A4_PORTRAIT), A4_PORTRAIT, {
      height: 60,
      width: 200,
      x: 120,
      y: 300,
    });
  });

  test("a click near the page edge keeps the stamp whole on the page", () => {
    const box = settleDrawnStampBox({
      anchor: at(590, 840),
      current: at(590, 840),
      page: A4_PORTRAIT,
    });
    expectPoints(box ?? defaultStampBox(A4_PORTRAIT), A4_PORTRAIT, {
      height: 60,
      width: 200,
      x: 595.28 - 200,
      y: 841.89 - 60,
    });
  });

  test("a drag too small grows to the smallest stamp from the corner it started at", () => {
    // Dragged up and to the left: the anchor is the box's bottom-right corner.
    const box = settleDrawnStampBox({
      anchor: at(400, 500),
      current: at(380, 490),
      page: A4_PORTRAIT,
    });
    expectPoints(box ?? defaultStampBox(A4_PORTRAIT), A4_PORTRAIT, {
      height: STAMP_LIMITS_PT.minHeight,
      width: STAMP_LIMITS_PT.minWidth,
      x: 400 - STAMP_LIMITS_PT.minWidth,
      y: 500 - STAMP_LIMITS_PT.minHeight,
    });
  });

  test("a drag too large shrinks to the largest stamp from the corner it started at", () => {
    const box = settleDrawnStampBox({
      anchor: at(50, 100),
      current: at(590, 800),
      page: A4_PORTRAIT,
    });
    expectPoints(box ?? defaultStampBox(A4_PORTRAIT), A4_PORTRAIT, {
      height: STAMP_LIMITS_PT.maxHeight,
      width: STAMP_LIMITS_PT.maxWidth,
      x: 50,
      y: 100,
    });
  });

  test("a drag inside the limits is kept as drawn", () => {
    const anchor = at(300, 260);
    const current = at(100, 200);
    expectSameBox(
      settleDrawnStampBox({ anchor, current, page: A4_PORTRAIT }),
      drawnStampBox({ anchor, current }),
    );
  });

  test("a page too small for any stamp takes none", () => {
    expect(
      settleDrawnStampBox({
        anchor: { x: 0, y: 0 },
        current: { x: 1, y: 1 },
        page: { height: 20, width: 200 },
      }),
    ).toBeNull();
  });
});

// From a sliver to well past A0, in points.
const LARGEST_PAGE_PT = 2000;
const pageSideArbitrary = fc.double({
  max: LARGEST_PAGE_PT,
  min: 1,
  noNaN: true,
});
const pageArbitrary = fc.record({
  height: pageSideArbitrary,
  width: pageSideArbitrary,
});
// Pointer positions run past the page on every side, as a drag can.
const POINTER_REACH = 0.5;
const pointerFractionArbitrary = fc.double({
  max: 1 + POINTER_REACH,
  min: -POINTER_REACH,
  noNaN: true,
});
const pointArbitrary = fc.record({
  x: pointerFractionArbitrary,
  y: pointerFractionArbitrary,
});

describe("released stamp drags", () => {
  test("every released drag leaves a stamp whole on the page and within the limits", () => {
    assertProperty(
      "every released drag leaves a stamp whole on the page and within the limits",
      fc.property(
        pageArbitrary,
        pointArbitrary,
        pointArbitrary,
        (page, anchor, current) => {
          const box = settleDrawnStampBox({ anchor, current, page });
          if (!canPlaceStamp(page)) {
            expect(box).toBeNull();
            return;
          }
          expect(box).not.toBeNull();
          if (box !== null) {
            expectWithinPageAndLimits(box, page);
          }
        },
      ),
    );
  });

  test("a drawn box always stays on the page, and a fitting one is kept on release", () => {
    assertProperty(
      "a drawn box always stays on the page, and a fitting one is kept on release",
      fc.property(
        pageArbitrary,
        pointArbitrary,
        pointArbitrary,
        (page, anchor, current) => {
          const drawn = drawnStampBox({ anchor, current });
          expect(drawn.x).toBeGreaterThanOrEqual(0);
          expect(drawn.y).toBeGreaterThanOrEqual(0);
          expect(drawn.x + drawn.width).toBeLessThanOrEqual(1 + EPSILON);
          expect(drawn.y + drawn.height).toBeLessThanOrEqual(1 + EPSILON);
          if (stampSizeCheck(drawn, page) === "fits") {
            expectSameBox(
              settleDrawnStampBox({ anchor, current, page }),
              drawn,
            );
          }
        },
      ),
    );
  });
});
