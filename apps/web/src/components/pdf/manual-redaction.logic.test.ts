import { describe, expect, test } from "bun:test";

import {
  createManualRedactionHistory,
  isManualRedactionPageRectUnchanged,
  manualRedactionFromDrag,
  manualRedactionToPdfPoints,
  reduceManualRedactionHistory,
} from "./manual-redaction.logic";
import type { ManualRedactionRegion } from "./manual-redaction.logic";

const region = {
  pageIndex: 2,
  left: 0.2,
  top: 0.25,
  right: 0.6,
  bottom: 0.75,
} satisfies ManualRedactionRegion;

describe("manual PDF redaction geometry", () => {
  test("scrolling or zooming invalidates the initial drag layout even at fractional sizes", () => {
    const initial = { left: 12.75, top: -50.25, width: 612.49, height: 792.51 };
    expect(isManualRedactionPageRectUnchanged(initial, { ...initial })).toBe(
      true,
    );
    for (const delta of [-20, -0.001, 0.001, 20]) {
      expect(
        isManualRedactionPageRectUnchanged(initial, {
          ...initial,
          left: initial.left + delta,
        }),
      ).toBe(false);
      expect(
        isManualRedactionPageRectUnchanged(initial, {
          ...initial,
          top: initial.top + delta,
        }),
      ).toBe(false);
      expect(
        isManualRedactionPageRectUnchanged(initial, {
          ...initial,
          width: initial.width + delta,
        }),
      ).toBe(false);
      expect(
        isManualRedactionPageRectUnchanged(initial, {
          ...initial,
          height: initial.height + delta,
        }),
      ).toBe(false);
    }
  });

  test.each([0.1, 0.25, 0.5, 1, 1.5, 2, 4])(
    "selection is independent of zoom and pointer direction (%s)",
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

  test("invalid pointer and layout values cannot produce redactions", () => {
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
  });

  test("PDF coordinates use the displayed page dimensions and invert only the vertical origin", () => {
    expect(
      manualRedactionToPdfPoints(region, {
        widthPoints: 600,
        heightPoints: 800,
      }),
    ).toEqual({ pageIndex: 2, left: 120, bottom: 200, right: 360, top: 600 });
    // The 90/270-degree views are landscape; 0/180-degree views are portrait.
    // Both operate on displayed coordinates, so no inverse raw-page rotation applies.
    expect(
      manualRedactionToPdfPoints(region, {
        widthPoints: 800,
        heightPoints: 600,
      }),
    ).toEqual({ pageIndex: 2, left: 160, bottom: 150, right: 480, top: 450 });
    const fullPage = { pageIndex: 0, left: 0, top: 0, right: 1, bottom: 1 };
    expect(
      manualRedactionToPdfPoints(fullPage, {
        widthPoints: 612.49,
        heightPoints: 792.51,
      }),
    ).toEqual({ pageIndex: 0, left: 0, bottom: 0, right: 612.49, top: 792.51 });
  });
});

describe("manual redaction history", () => {
  test("history owns a snapshot of an added selection", () => {
    const selection = { ...region, id: "first" };
    const history = reduceManualRedactionHistory(
      createManualRedactionHistory(),
      { type: "add", selection },
    );
    selection.left = 0.1;
    expect(history.present.at(0)?.left).toBe(region.left);
  });

  test("add, remove, and reset are immutable and reversible", () => {
    const initial = createManualRedactionHistory();
    const first = { ...region, id: "first" };
    const second = { ...region, pageIndex: 3, id: "second" };
    const addedFirst = reduceManualRedactionHistory(initial, {
      type: "add",
      selection: first,
    });
    const addedSecond = reduceManualRedactionHistory(addedFirst, {
      type: "add",
      selection: second,
    });
    const removed = reduceManualRedactionHistory(addedSecond, {
      type: "remove",
      id: first.id,
    });
    expect(initial.present).toEqual([]);
    expect(addedFirst.present).toEqual([first]);
    expect(addedSecond.present).toEqual([first, second]);
    expect(removed.present).toEqual([second]);
    const restored = reduceManualRedactionHistory(removed, { type: "undo" });
    expect(restored.present).toEqual(addedSecond.present);
    expect(reduceManualRedactionHistory(restored, { type: "redo" })).toEqual(
      removed,
    );
    const reset = reduceManualRedactionHistory(addedSecond, { type: "reset" });
    expect(reset.present).toEqual([]);
    expect(
      reduceManualRedactionHistory(reset, { type: "undo" }).present,
    ).toEqual(addedSecond.present);
  });

  test("new edits discard redo while no-op actions preserve history", () => {
    const initial = createManualRedactionHistory();
    expect(reduceManualRedactionHistory(initial, { type: "undo" })).toBe(
      initial,
    );
    expect(reduceManualRedactionHistory(initial, { type: "redo" })).toBe(
      initial,
    );
    expect(reduceManualRedactionHistory(initial, { type: "reset" })).toBe(
      initial,
    );
    const added = reduceManualRedactionHistory(initial, {
      type: "add",
      selection: { ...region, id: "first" },
    });
    expect(
      reduceManualRedactionHistory(added, { type: "remove", id: "missing" }),
    ).toBe(added);
    const undone = reduceManualRedactionHistory(added, { type: "undo" });
    const replaced = reduceManualRedactionHistory(undone, {
      type: "add",
      selection: { ...region, id: "replacement" },
    });
    expect(replaced.future).toEqual([]);
    expect(reduceManualRedactionHistory(replaced, { type: "redo" })).toBe(
      replaced,
    );
  });

  test("retained undo history is bounded without losing older marks", () => {
    let history = createManualRedactionHistory();
    for (let index = 0; index < 150; index++) {
      history = reduceManualRedactionHistory(history, {
        type: "add",
        selection: { ...region, id: String(index) },
      });
    }
    expect(history.past).toHaveLength(100);
    expect(history.present).toHaveLength(150);
    for (let index = 0; index < 100; index++) {
      history = reduceManualRedactionHistory(history, { type: "undo" });
    }
    expect(history.present).toHaveLength(50);
    expect(reduceManualRedactionHistory(history, { type: "undo" })).toBe(
      history,
    );
    for (let index = 0; index < 100; index++) {
      history = reduceManualRedactionHistory(history, { type: "redo" });
    }
    expect(history.present).toHaveLength(150);
    expect(history.future).toEqual([]);
  });
});
