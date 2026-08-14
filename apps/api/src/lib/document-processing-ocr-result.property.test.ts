import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  buildOcrPage,
  isSupportedOcrPageCount,
  parseOcrPage,
} from "@/api/lib/document-processing-ocr-result";

/**
 * Fixed point between the worker-side page builder and the parent-side
 * validator: whatever geometry recognition produces — fractional MediaBox
 * dimensions, edge-touching boxes, float drift slightly past the page —
 * the built page must survive a JSON round trip and validation. This pins
 * the class of failure where a producer emits output its own consumer
 * rejects, which previously surfaced only on PDFs with fractional page
 * sizes.
 */

const dimensionArb = fc.double({
  min: 0.51,
  max: 5000,
  noNaN: true,
  noDefaultInfinity: true,
});

const lineArb = (pointWidth: number, pointHeight: number) =>
  fc
    .record({
      // Coordinates may drift slightly beyond the page: recognition boxes
      // are scaled back from render space with float arithmetic.
      x0: fc.double({ min: -1, max: pointWidth + 1, noNaN: true }),
      y0: fc.double({ min: -1, max: pointHeight + 1, noNaN: true }),
      spanX: fc.double({ min: 0, max: pointWidth + 1, noNaN: true }),
      spanY: fc.double({ min: 0, max: pointHeight + 1, noNaN: true }),
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      text: fc.string({ minLength: 1, maxLength: 40 }),
    })
    .filter(({ text }) => text.trim().length > 0)
    .map(({ confidence, spanX, spanY, text, x0, y0 }) => ({
      box: [x0, y0, x0 + spanX, y0 + spanY] satisfies [
        number,
        number,
        number,
        number,
      ],
      confidence,
      text,
    }));

const pageInputArb = fc
  .record({ pointHeight: dimensionArb, pointWidth: dimensionArb })
  .chain(({ pointHeight, pointWidth }) =>
    fc.record({
      pointHeight: fc.constant(pointHeight),
      pointWidth: fc.constant(pointWidth),
      lines: fc.array(lineArb(pointWidth, pointHeight), { maxLength: 8 }),
    }),
  );

describe("buildOcrPage → parseOcrPage fixed point", () => {
  test("every built page validates after a JSON round trip", () => {
    fc.assert(
      fc.property(pageInputArb, ({ lines, pointHeight, pointWidth }) => {
        const page = buildOcrPage({ lines, pointHeight, pointWidth });
        // A JSON round trip, not a clone: the worker serializes pages over
        // stdout, so JSON semantics are part of the invariant.
        const serialized = JSON.stringify(page);
        const roundTripped: unknown = JSON.parse(serialized);
        const parsed = parseOcrPage(roundTripped);
        expect(parsed).not.toBeNull();
        // Clamping must never invent geometry: every surviving box sits
        // inside the integer page.
        for (const line of parsed?.lines ?? []) {
          expect(line.box[0]).toBeGreaterThanOrEqual(0);
          expect(line.box[1]).toBeGreaterThanOrEqual(0);
          expect(line.box[2]).toBeLessThanOrEqual(page.width);
          expect(line.box[3]).toBeLessThanOrEqual(page.height);
        }
      }),
      propertyConfig(),
    );
  });
});

describe("isSupportedOcrPageCount", () => {
  test("enforces the bounded document limit", () => {
    expect(isSupportedOcrPageCount(1)).toBe(true);
    expect(isSupportedOcrPageCount(0)).toBe(false);
    expect(isSupportedOcrPageCount(-1)).toBe(false);
    expect(isSupportedOcrPageCount(500)).toBe(true);
    expect(isSupportedOcrPageCount(501)).toBe(false);
  });
});
