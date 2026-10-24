import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { isPageTransformRequest } from "@/lib/pdf/page-editor/page-editor-protocol";

import {
  adjustCropBox,
  clampCropMarginsMm,
  CROP_ADJUST_MODES,
  cropKeyDelta,
  cropToMarginsMm,
  displayedCropBox,
  displayedPageSizeMm,
  marginsFromDisplayedBox,
  marginsMmToCrop,
} from "./page-organizer-crop.logic";

const MAX_GENERATED_PAGE_POINTS = 3000;
const MAX_GENERATED_DELTA = 100;
const MAX_GENERATED_MARGIN_MM = 2000;

const pageArbitrary = fc.record({
  width: fc.integer({ min: 30, max: MAX_GENERATED_PAGE_POINTS }),
  height: fc.integer({ min: 30, max: MAX_GENERATED_PAGE_POINTS }),
  rotation: fc.constantFrom(
    0 as const,
    90 as const,
    180 as const,
    270 as const,
  ),
});
const marginsArbitrary = fc.record({
  top: fc.integer({ min: -100, max: MAX_GENERATED_MARGIN_MM }),
  right: fc.integer({ min: -100, max: MAX_GENERATED_MARGIN_MM }),
  bottom: fc.integer({ min: -100, max: MAX_GENERATED_MARGIN_MM }),
  left: fc.integer({ min: -100, max: MAX_GENERATED_MARGIN_MM }),
});

test("pdf crop millimetre round trip within 0.01 mm", () => {
  assertProperty(
    "pdf crop millimetre round trip within 0.01 mm",
    fc.property(pageArbitrary, marginsArbitrary, (page, requested) => {
      const margins = clampCropMarginsMm(requested, page);
      const roundTrip = cropToMarginsMm(marginsMmToCrop(margins, page), page);
      const displayRoundTrip = marginsFromDisplayedBox(
        displayedCropBox(margins, page),
        page,
      );
      const expected = {
        top: expect.closeTo(margins.top, 2),
        right: expect.closeTo(margins.right, 2),
        bottom: expect.closeTo(margins.bottom, 2),
        left: expect.closeTo(margins.left, 2),
      } satisfies Record<keyof typeof margins, unknown>;
      expect(roundTrip).toEqual(expected);
      expect(displayRoundTrip).toEqual(expected);
    }),
  );
});

test("pdf crop gestures preserve bounds and minimum physical size", () => {
  assertProperty(
    "pdf crop gestures preserve bounds and minimum physical size",
    fc.property(
      pageArbitrary,
      marginsArbitrary,
      fc.constantFrom(...CROP_ADJUST_MODES),
      fc.record({
        x: fc.integer({ min: -100, max: MAX_GENERATED_DELTA }),
        y: fc.integer({ min: -100, max: MAX_GENERATED_DELTA }),
      }),
      (page, margins, mode, delta) => {
        const box = displayedCropBox(margins, page);
        const changed = adjustCropBox({ box, delta, mode, page });
        const size = displayedPageSizeMm(page);
        expect(changed.x).toBeGreaterThanOrEqual(-1e-10);
        expect(changed.y).toBeGreaterThanOrEqual(-1e-10);
        expect(changed.x + changed.width).toBeLessThanOrEqual(1 + 1e-10);
        expect(changed.y + changed.height).toBeLessThanOrEqual(1 + 1e-10);
        expect(changed.width * size.width).toBeGreaterThanOrEqual(10 - 1e-10);
        expect(changed.height * size.height).toBeGreaterThanOrEqual(10 - 1e-10);
        if (mode === "move") {
          expect(changed.width).toBe(box.width);
          expect(changed.height).toBe(box.height);
        }
        if (mode !== "move" && mode.includes("w")) {
          expect(changed.x + changed.width).toBeCloseTo(box.x + box.width, 10);
        }
        if (mode !== "move" && mode.includes("n")) {
          expect(changed.y + changed.height).toBeCloseTo(
            box.y + box.height,
            10,
          );
        }
        if (mode !== "move" && mode.includes("e")) {
          expect(changed.x).toBe(box.x);
        }
        if (mode !== "move" && mode.includes("s")) {
          expect(changed.y).toBe(box.y);
        }
      },
    ),
  );
});

test("physical margins use rotated display dimensions and worker bottom-left origin", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const page = { width: 720, height: 360, rotation };
    const rotated = rotation === 90 || rotation === 270;
    const widthMm = rotated ? 127 : 254;
    const heightMm = rotated ? 254 : 127;
    const crop = marginsMmToCrop(
      { top: 10, right: 20, bottom: 30, left: 40 },
      page,
    );
    expect(crop.x).toBeCloseTo(40 / widthMm, 10);
    expect(crop.y).toBeCloseTo(30 / heightMm, 10);
    expect(crop.width).toBeCloseTo(1 - 60 / widthMm, 10);
    expect(crop.height).toBeCloseTo(1 - 40 / heightMm, 10);
  }
});

test("same millimetre margins produce distinct crops on mixed page sizes", () => {
  const margins = { top: 10, right: 20, bottom: 30, left: 40 };
  const small = { width: 360, height: 720, rotation: 0 as const };
  const large = { width: 720, height: 1440, rotation: 0 as const };
  const smallCrop = marginsMmToCrop(margins, small);
  const largeCrop = marginsMmToCrop(margins, large);
  expect(smallCrop.x).toBeCloseTo(largeCrop.x * 2, 10);
  expect(smallCrop.y).toBeCloseTo(largeCrop.y * 2, 10);
  expect(cropToMarginsMm(undefined, small)).toEqual({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
});

test("physically tiny pages remain uncropped", () => {
  const page = { width: 20, height: 20, rotation: 0 as const };
  expect(
    clampCropMarginsMm({ top: 20, right: 20, bottom: 20, left: 20 }, page),
  ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});

test("arrow keys nudge one millimetre or ten with Shift", () => {
  expect(cropKeyDelta("ArrowLeft", false)).toEqual({ x: -1, y: 0 });
  expect(cropKeyDelta("ArrowRight", true)).toEqual({ x: 10, y: 0 });
  expect(cropKeyDelta("ArrowUp", true)).toEqual({ x: 0, y: -10 });
  expect(cropKeyDelta("ArrowDown", false)).toEqual({ x: 0, y: 1 });
  expect(cropKeyDelta("Enter", false)).toBeNull();
});

test("pdf crop normalized output satisfies the worker protocol", () => {
  const positive = fc.double({
    min: 30,
    max: MAX_GENERATED_PAGE_POINTS,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const margin = fc.oneof(
    fc.constant(0),
    fc.double({
      min: 0,
      max: MAX_GENERATED_MARGIN_MM,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  );
  assertProperty(
    "pdf crop normalized output satisfies the worker protocol",
    fc.property(
      fc.record({
        width: positive,
        height: positive,
        rotation: fc.constantFrom(
          0 as const,
          90 as const,
          180 as const,
          270 as const,
        ),
      }),
      fc.record({ top: margin, right: margin, bottom: margin, left: margin }),
      (page, margins) => {
        const crop = marginsMmToCrop(margins, page);
        expect(
          isPageTransformRequest({
            requestId: 1,
            sources: [{ id: "source", bytes: new ArrayBuffer(0) }],
            pages: [
              {
                id: "page",
                sourceId: "source",
                sourcePageIndex: 0,
                rotation: page.rotation,
                crop,
              },
            ],
            outputs: [["page"]],
          }),
        ).toBe(true);
      },
    ),
    { numRuns: 500 },
  );
});
