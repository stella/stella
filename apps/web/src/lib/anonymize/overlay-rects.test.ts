import { describe, expect, it } from "bun:test";

import { getOverlayRectKey, projectOverlayRects } from "./overlay-rects";

describe("getOverlayRectKey", () => {
  const rect = { left: 10, top: 20, width: 50, height: 12 };

  it("is stable when rectangle order changes", () => {
    const otherRect = { left: 10, top: 40, width: 50, height: 12 };
    const before = [rect, otherRect].map((value) =>
      getOverlayRectKey({ entityId: 7, rect: value }),
    );
    const after = [otherRect, rect].map((value) =>
      getOverlayRectKey({ entityId: 7, rect: value }),
    );

    expect(after.toSorted()).toEqual(before.toSorted());
  });

  it("distinguishes entities and rectangle geometry", () => {
    const key = getOverlayRectKey({ entityId: 7, rect });

    expect(getOverlayRectKey({ entityId: 8, rect })).not.toBe(key);
    expect(
      getOverlayRectKey({ entityId: 7, rect: { ...rect, top: 21 } }),
    ).not.toBe(key);
  });
});

describe("projectOverlayRects", () => {
  // PDF user space has its origin bottom-left; the viewport flips y and
  // scales, which is all a page viewport does at rotation 0.
  const scale = 2;
  const pageHeight = 800;
  const viewport = {
    convertToViewportPoint: (x: number, y: number) => [
      x * scale,
      (pageHeight - y) * scale,
    ],
  };
  const entity = {
    id: 3,
    label: "PERSON",
    text: "Novak",
    boxesByPage: new Map([
      [0, [{ x: 10, y: 700, width: 40, height: 12 }]],
      [2, [{ x: 5, y: 100, width: 10, height: 10 }]],
    ]),
  };

  it("projects the page's glyph boxes into the viewport", () => {
    const rects = projectOverlayRects({
      entities: [entity],
      pageIndex: 0,
      viewport,
    });

    expect(rects.get(3)).toEqual([
      { left: 20, top: 176, width: 80, height: 24 },
    ]);
  });

  it("draws nothing for an entity with no boxes on the page", () => {
    expect(
      projectOverlayRects({ entities: [entity], pageIndex: 1, viewport }).size,
    ).toBe(0);
  });
});
