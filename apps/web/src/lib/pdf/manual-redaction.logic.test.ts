import { describe, expect, test } from "bun:test";

import {
  isManualRedactionPageRectUnchanged,
  isValidManualRedactionArea,
  manualRedactionAreaToPdfBox,
  manualRedactionFromDrag,
  manualRedactionPageMatches,
  pdfDocumentKey,
  reduceManualRedactionAreas,
} from "@/lib/pdf/manual-redaction.logic";
import type {
  ManualRedactionArea,
  ManualRedactionRegion,
} from "@/lib/pdf/manual-redaction.logic";

const region = {
  pageIndex: 2,
  left: 0.2,
  top: 0.25,
  right: 0.6,
  bottom: 0.75,
} satisfies ManualRedactionRegion;

const area = (id: string, pageIndex = 2): ManualRedactionArea => ({
  ...region,
  pageIndex,
  id,
  pageWidth: 600,
  pageHeight: 800,
});

describe("manual redaction drags", () => {
  test("scrolling or zooming invalidates the initial drag layout even at fractional sizes", () => {
    const initial = { left: 12.75, top: -50.25, width: 612.49, height: 792.51 };
    expect(isManualRedactionPageRectUnchanged(initial, { ...initial })).toBe(
      true,
    );
    for (const delta of [-20, -0.001, 0.001, 20]) {
      for (const moved of [
        { ...initial, left: initial.left + delta },
        { ...initial, top: initial.top + delta },
        { ...initial, width: initial.width + delta },
        { ...initial, height: initial.height + delta },
      ]) {
        expect(isManualRedactionPageRectUnchanged(initial, moved)).toBe(false);
      }
    }
  });

  test.each([0.1, 0.25, 0.5, 1, 1.5, 2, 4])(
    "an area is independent of zoom and pointer direction (%s)",
    (zoom) => {
      const pageRect = {
        left: -23.7,
        top: 54.3,
        width: 612.49 * zoom,
        height: 792.51 * zoom,
      };
      const start = {
        x: pageRect.left + region.left * pageRect.width,
        y: pageRect.top + region.top * pageRect.height,
      };
      const end = {
        x: pageRect.left + region.right * pageRect.width,
        y: pageRect.top + region.bottom * pageRect.height,
      };
      const forward = manualRedactionFromDrag({
        pageIndex: region.pageIndex,
        pageRect,
        start,
        end,
      });
      const reverse = manualRedactionFromDrag({
        pageIndex: region.pageIndex,
        pageRect,
        start: end,
        end: start,
      });
      expect(forward).not.toBeNull();
      expect(reverse).toEqual(forward);
      expect(forward?.pageIndex).toBe(region.pageIndex);
      expect(forward?.left).toBeCloseTo(region.left, 12);
      expect(forward?.top).toBeCloseTo(region.top, 12);
      expect(forward?.right).toBeCloseTo(region.right, 12);
      expect(forward?.bottom).toBeCloseTo(region.bottom, 12);
    },
  );

  test("clamps across page edges and ignores drags wholly outside the page", () => {
    const pageRect = { left: 10.5, top: 20.25, width: 200.5, height: 300.25 };
    expect(
      manualRedactionFromDrag({
        pageIndex: 0,
        pageRect,
        start: { x: -100, y: -100 },
        end: { x: 500, y: 500 },
      }),
    ).toEqual({ pageIndex: 0, left: 0, top: 0, right: 1, bottom: 1 });
    expect(
      manualRedactionFromDrag({
        pageIndex: 0,
        pageRect,
        start: { x: -100, y: -100 },
        end: { x: 0, y: 0 },
      }),
    ).toBeNull();
  });

  test("rejects zero and tiny areas at every zoom", () => {
    for (const zoom of [0.25, 1, 4]) {
      const pageRect = {
        left: 0,
        top: 0,
        width: 200 * zoom,
        height: 300 * zoom,
      };
      for (const edge of [0, 0.0001, 0.001]) {
        expect(
          manualRedactionFromDrag({
            pageIndex: 0,
            pageRect,
            start: { x: 0, y: 0 },
            end: { x: edge * pageRect.width, y: pageRect.height },
          }),
        ).toBeNull();
        expect(
          manualRedactionFromDrag({
            pageIndex: 0,
            pageRect,
            start: { x: 0, y: 0 },
            end: { x: pageRect.width, y: edge * pageRect.height },
          }),
        ).toBeNull();
      }
    }
  });

  test("invalid pointer and layout values cannot produce areas", () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(
        manualRedactionFromDrag({
          pageIndex: 0,
          start: { x: value, y: 0 },
          end: { x: 100, y: 100 },
          pageRect: { left: 0, top: 0, width: 200, height: 300 },
        }),
      ).toBeNull();
    }
    for (const width of [0, -1, Number.NaN, Infinity]) {
      expect(
        manualRedactionFromDrag({
          pageIndex: 0,
          start: { x: 0, y: 0 },
          end: { x: 100, y: 100 },
          pageRect: { left: 0, top: 0, width, height: 300 },
        }),
      ).toBeNull();
    }
    for (const pageIndex of [-1, 0.5, Number.NaN]) {
      expect(
        manualRedactionFromDrag({
          pageIndex,
          start: { x: 0, y: 0 },
          end: { x: 100, y: 100 },
          pageRect: { left: 0, top: 0, width: 200, height: 300 },
        }),
      ).toBeNull();
    }
  });
});

describe("manual redaction areas", () => {
  test("add keeps a snapshot; remove and clear return the same list when nothing changes", () => {
    const first = { ...area("first") };
    const added = reduceManualRedactionAreas([], { type: "add", area: first });
    expect(added).toEqual([area("first")]);
    expect(added.at(0)).not.toBe(first);

    const both = reduceManualRedactionAreas(added, {
      type: "add",
      area: area("second", 3),
    });
    expect(
      reduceManualRedactionAreas(both, { type: "remove", id: "first" }),
    ).toEqual([area("second", 3)]);
    expect(
      reduceManualRedactionAreas(both, { type: "remove", id: "missing" }),
    ).toBe(both);
    expect(reduceManualRedactionAreas(both, { type: "clear" })).toEqual([]);
    const empty: readonly ManualRedactionArea[] = [];
    expect(reduceManualRedactionAreas(empty, { type: "clear" })).toBe(empty);
  });

  test("an invalid or duplicate area is a programming error", () => {
    const added = reduceManualRedactionAreas([], {
      type: "add",
      area: area("first"),
    });
    expect(() =>
      reduceManualRedactionAreas(added, { type: "add", area: area("first") }),
    ).toThrow("must be valid and have a unique id");
    for (const invalid of [
      { ...area("x"), id: "" },
      { ...area("x"), right: region.left },
      { ...area("x"), bottom: 1.5 },
      { ...area("x"), pageWidth: 0 },
      { ...area("x"), pageHeight: Number.NaN },
    ]) {
      expect(isValidManualRedactionArea(invalid)).toBe(false);
      expect(() =>
        reduceManualRedactionAreas([], { type: "add", area: invalid }),
      ).toThrow("must be valid and have a unique id");
    }
  });

  test("a page matches only at the displayed size the area was drawn on", () => {
    expect(
      manualRedactionPageMatches(area("a"), { width: 600, height: 800 }),
    ).toBe(true);
    expect(
      manualRedactionPageMatches(area("a"), { width: 600.004, height: 800 }),
    ).toBe(true);
    // A rotated or replaced page swaps or changes the displayed size.
    expect(
      manualRedactionPageMatches(area("a"), { width: 800, height: 600 }),
    ).toBe(false);
    expect(
      manualRedactionPageMatches(area("a"), { width: 600, height: 801 }),
    ).toBe(false);
  });

  test("document keys differ whenever either fingerprint differs", () => {
    expect(pdfDocumentKey(["a", "b"])).toBe(pdfDocumentKey(["a", "b"]));
    expect(pdfDocumentKey(["a", "b"])).not.toBe(pdfDocumentKey(["a", "c"]));
    expect(pdfDocumentKey(["a", null])).not.toBe(pdfDocumentKey(["a", "b"]));
  });
});

type FakeViewportOptions = {
  pageWidth: number;
  pageHeight: number;
  rotation: 0 | 90;
  scale: number;
};

// PDF.js maps an unrotated page with the origin flipped to the top, and a
// 90-degree page with its axes exchanged.
const fakeViewport = ({
  pageWidth,
  pageHeight,
  rotation,
  scale,
}: FakeViewportOptions) =>
  rotation === 0
    ? {
        width: pageWidth * scale,
        height: pageHeight * scale,
        convertToPdfPoint: (x: number, y: number) => [
          x / scale,
          pageHeight - y / scale,
        ],
      }
    : {
        width: pageHeight * scale,
        height: pageWidth * scale,
        convertToPdfPoint: (x: number, y: number) => [y / scale, x / scale],
      };

describe("manual redaction areas in PDF space", () => {
  test("an unrotated page inverts the vertical origin only", () => {
    expect(
      manualRedactionAreaToPdfBox(
        region,
        fakeViewport({
          pageWidth: 600,
          pageHeight: 800,
          rotation: 0,
          scale: 2,
        }),
      ),
    ).toEqual({ x: 120, y: 200, width: 240, height: 400 });
  });

  test("a rotated page maps the displayed area back onto the raw page", () => {
    // Displayed 800 x 600: the area spans x 160..480 and y 150..450 on
    // screen, which are the raw page's y and x ranges.
    expect(
      manualRedactionAreaToPdfBox(
        region,
        fakeViewport({
          pageWidth: 600,
          pageHeight: 800,
          rotation: 90,
          scale: 2,
        }),
      ),
    ).toEqual({ x: 150, y: 160, width: 300, height: 320 });
  });

  test("an invalid region or a viewport without a point has no box", () => {
    const viewport = fakeViewport({
      pageWidth: 600,
      pageHeight: 800,
      rotation: 0,
      scale: 1,
    });
    expect(
      manualRedactionAreaToPdfBox({ ...region, right: 0.1 }, viewport),
    ).toBeNull();
    expect(
      manualRedactionAreaToPdfBox(region, {
        ...viewport,
        convertToPdfPoint: () => [Number.NaN, 0],
      }),
    ).toBeNull();
  });
});
