import { describe, expect, it } from "bun:test";

import {
  consumePDFWheelZoomEvent,
  getPDFWheelZoomScaleOffset,
  PDF_MAX_SCALE_OFFSET,
  PDF_MIN_SCALE_OFFSET,
} from "@/lib/pdf/pdf-zoom.logic";

describe("PDF wheel zoom", () => {
  it("keeps ordinary scrolling native", () => {
    let prevented = false;
    let receivedDelta: number | undefined;

    const consumed = consumePDFWheelZoomEvent(
      {
        ctrlKey: false,
        deltaY: -20,
        preventDefault: () => {
          prevented = true;
        },
      },
      (deltaY) => {
        receivedDelta = deltaY;
      },
    );

    expect(consumed).toBe(false);
    expect(prevented).toBe(false);
    expect(receivedDelta).toBeUndefined();
  });

  it("consumes trackpad pinch gestures before they reach browser zoom", () => {
    let prevented = false;
    let receivedDelta: number | undefined;

    const consumed = consumePDFWheelZoomEvent(
      {
        ctrlKey: true,
        deltaY: -20,
        preventDefault: () => {
          prevented = true;
        },
      },
      (deltaY) => {
        receivedDelta = deltaY;
      },
    );

    expect(consumed).toBe(true);
    expect(prevented).toBe(true);
    expect(receivedDelta).toBe(-20);
  });

  it("keeps every wheel-derived offset within the viewer bounds", () => {
    const cases = [
      { current: 0, deltaY: -20, expected: 0.1 },
      { current: 0, deltaY: 20, expected: -0.1 },
      { current: PDF_MAX_SCALE_OFFSET, deltaY: -100, expected: 2 },
      { current: PDF_MIN_SCALE_OFFSET, deltaY: 100, expected: -0.8 },
    ];

    for (const { current, deltaY, expected } of cases) {
      const offset = getPDFWheelZoomScaleOffset(current, deltaY);

      expect(offset).toBe(expected);
      expect(offset).toBeGreaterThanOrEqual(PDF_MIN_SCALE_OFFSET);
      expect(offset).toBeLessThanOrEqual(PDF_MAX_SCALE_OFFSET);
    }
  });
});
