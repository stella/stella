import { describe, expect, test } from "bun:test";

import {
  canvasScale,
  FIT_ZOOM,
  folioZoom,
  MAX_CANVAS_PIXELS,
  nextAppearance,
  pageAppearance,
  ZOOM_STEPS,
  zoomedIn,
  zoomedOut,
} from "./zoom";

describe("zoom steps", () => {
  test("opens at the fit, which is one of the steps", () => {
    expect(ZOOM_STEPS).toContain(FIT_ZOOM);
  });

  test("walks up and down one step at a time and stops at either end", () => {
    expect(zoomedIn(1)).toBe(1.25);
    expect(zoomedOut(1)).toBe(0.75);
    expect(zoomedIn(3)).toBe(3);
    expect(zoomedOut(0.5)).toBe(0.5);
  });

  test("goes back to where it came from", () => {
    for (const step of ZOOM_STEPS.slice(0, -1)) {
      expect(zoomedOut(zoomedIn(step))).toBe(step);
    }
  });

  test("lands on a step from a zoom between them", () => {
    expect(zoomedIn(1.1)).toBe(1.25);
    expect(zoomedOut(1.1)).toBe(1);
  });
});

describe("folioZoom", () => {
  test("scales folio's own fit", () => {
    expect(folioZoom(0.4, 1)).toBeCloseTo(0.4);
    expect(folioZoom(0.4, 2)).toBeCloseTo(0.8);
  });

  test("stays within folio's bounds", () => {
    expect(folioZoom(0.4, 0.5)).toBe(0.25);
    expect(folioZoom(0.9, 3)).toBe(2);
  });
});

describe("canvasScale", () => {
  const letter = { pageWidth: 612, pageHeight: 792 };

  test("draws a fitted page sharp at the screen's pixel ratio", () => {
    expect(canvasScale({ ...letter, cssWidth: 351, pixelRatio: 3 })).toBe(
      (351 / 612) * 3,
    );
  });

  test("keeps a zoomed page's canvas within WebKit's limit", () => {
    const scale = canvasScale({ ...letter, cssWidth: 351 * 3, pixelRatio: 3 });
    const pixels = 612 * scale * 792 * scale;
    expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
    expect(pixels).toBeGreaterThan(MAX_CANVAS_PIXELS * 0.99);
  });
});

describe("appearance", () => {
  test("cycles automatic, light, dark and back", () => {
    expect(nextAppearance("system")).toBe("light");
    expect(nextAppearance("light")).toBe("dark");
    expect(nextAppearance("dark")).toBe("system");
  });

  test("follows the app only when automatic", () => {
    expect(pageAppearance("system", "dark")).toBe("dark");
    expect(pageAppearance("system", "light")).toBe("light");
    expect(pageAppearance("light", "dark")).toBe("light");
    expect(pageAppearance("dark", "light")).toBe("dark");
  });
});
