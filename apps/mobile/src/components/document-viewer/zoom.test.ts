import { describe, expect, test } from "bun:test";

import {
  canvasScale,
  docxZoomTarget,
  FIT_ZOOM,
  folioZoom,
  MAX_CANVAS_PIXELS,
  nextAppearance,
  pageAppearance,
  scaledScroll,
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
    expect(zoomedIn(2)).toBe(2);
    expect(zoomedOut(0.75)).toBe(0.75);
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
    expect(folioZoom(0.2, 0.75)).toBe(0.25);
    expect(folioZoom(1.2, 2)).toBe(2);
  });

  test("keeps every step distinct for a phone's fit", () => {
    const zooms = ZOOM_STEPS.map((step) => folioZoom(0.45, step));
    expect(new Set(zooms).size).toBe(ZOOM_STEPS.length);
  });
});

describe("docxZoomTarget", () => {
  const fit = { fitPerPixel: 0.45 / 375, width: 375 };

  test("leaves folio fitting the page until the first zoom", () => {
    expect(docxZoomTarget({ ...fit, zoom: FIT_ZOOM, zoomed: false })).toBe(
      null,
    );
  });

  test("waits for folio's first fit", () => {
    expect(
      docxZoomTarget({ fitPerPixel: null, width: 375, zoom: 2, zoomed: true }),
    ).toBe(null);
  });

  test("scales the fit by the step", () => {
    expect(docxZoomTarget({ ...fit, zoom: 2, zoomed: true })).toBeCloseTo(0.9);
  });

  test("goes back to the fit once zoomed, at the screen's current width", () => {
    expect(
      docxZoomTarget({ ...fit, zoom: FIT_ZOOM, zoomed: true }),
    ).toBeCloseTo(0.45);
    expect(
      docxZoomTarget({ ...fit, width: 812, zoom: FIT_ZOOM, zoomed: true }),
    ).toBeCloseTo((0.45 / 375) * 812);
  });
});

describe("scaledScroll", () => {
  test("keeps the middle of the screen on the same point", () => {
    const offset = scaledScroll({
      offset: 1000,
      viewport: 800,
      ratio: 2,
      lead: 0,
    });
    expect((offset + 400) / 2).toBe(1000 + 400);
  });

  test("leaves the padding before the content unscaled", () => {
    const lead = 12;
    const offset = scaledScroll({
      offset: 1000,
      viewport: 800,
      ratio: 2,
      lead,
    });
    expect((offset + 400 - lead) / 2).toBe(1000 + 400 - lead);
  });

  test("never scrolls before the start", () => {
    expect(
      scaledScroll({ offset: 0, viewport: 800, ratio: 0.5, lead: 12 }),
    ).toBe(0);
  });
});

describe("canvasScale", () => {
  const letter = { pageWidth: 612, pageHeight: 792 };

  test("draws a fitted page sharp at the screen's pixel ratio", () => {
    expect(canvasScale({ ...letter, cssWidth: 351, pixelRatio: 3 })).toBe(
      (351 / 612) * 3,
    );
  });

  test("leaves a page under the limit at full sharpness", () => {
    expect(canvasScale({ ...letter, cssWidth: 1053, pixelRatio: 3 })).toBe(
      (1053 / 612) * 3,
    );
  });

  test("keeps a page over the limit within it, and just under", () => {
    const sharp = (1300 / 612) * 3;
    expect(612 * sharp * 792 * sharp).toBeGreaterThan(MAX_CANVAS_PIXELS);
    const scale = canvasScale({ ...letter, cssWidth: 1300, pixelRatio: 3 });
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
