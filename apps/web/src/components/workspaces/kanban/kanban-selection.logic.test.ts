import { describe, expect, test } from "bun:test";

import {
  applyMarqueeSelection,
  buildKanbanCardDragData,
  getDraggedItems,
  getMarqueeRect,
  hasPassedMarqueeThreshold,
  isInsideClientArea,
  MARQUEE_MODE,
  readKanbanDraggedCards,
  readSourceSubgroupValue,
  rectsIntersect,
} from "./kanban-selection.logic";
import type { KanbanCardDragItem } from "./kanban-selection.logic";

const card = (
  entityId: string,
  subgroupValue: string | null | undefined = undefined,
): KanbanCardDragItem => ({
  entityId,
  name: `Card ${entityId}`,
  kind: "task",
  mimeType: null,
  parentId: null,
  subgroupValue,
});

describe("kanban card drag payload", () => {
  test("carries every selected card with its own source lane", () => {
    const primary = card("b", "workspace-user:u2");
    const items = [primary, card("a", null), card("c", "workspace-user:u1")];

    const data = buildKanbanCardDragData({ primary, items });

    expect(readKanbanDraggedCards(data)).toEqual([
      { entityId: "b", subgroupValue: "workspace-user:u2" },
      { entityId: "a", subgroupValue: null },
      { entityId: "c", subgroupValue: "workspace-user:u1" },
    ]);
    // Drop targets outside the board read the shared entity fields.
    expect(data["entityId"]).toBe("b");
    expect(data["entityIds"]).toEqual(["b", "a", "c"]);
    expect(data["subgroupValue"]).toBe("workspace-user:u2");
  });

  test("reads an entity drag from outside the board as one card", () => {
    expect(
      readKanbanDraggedCards({ entityId: "row-1", subgroupValue: null }),
    ).toEqual([{ entityId: "row-1", subgroupValue: null }]);
    expect(readKanbanDraggedCards({ entityId: "row-1" })).toEqual([
      { entityId: "row-1", subgroupValue: undefined },
    ]);
  });

  test("reads nothing from a payload with no entity", () => {
    expect(readKanbanDraggedCards({ columnValue: "open" })).toEqual([]);
  });

  test("ignores a malformed card list and falls back to the named entity", () => {
    expect(
      readKanbanDraggedCards({
        entityId: "a",
        kanbanCards: [{ entityId: 7 }],
      }),
    ).toEqual([{ entityId: "a", subgroupValue: undefined }]);
  });
});

describe("readSourceSubgroupValue", () => {
  test("keeps a string lane value", () => {
    expect(
      readSourceSubgroupValue({ subgroupValue: "workspace-user:u1" }),
    ).toBe("workspace-user:u1");
  });

  test("keeps an explicit null (the Unassigned lane) distinct from absence", () => {
    expect(readSourceSubgroupValue({ subgroupValue: null })).toBeNull();
  });

  test("reports undefined when the payload carries no lane at all", () => {
    expect(readSourceSubgroupValue({})).toBeUndefined();
  });

  test("never trusts a non-string, non-null value", () => {
    expect(readSourceSubgroupValue({ subgroupValue: 42 })).toBeUndefined();
    expect(
      readSourceSubgroupValue({ subgroupValue: { nested: true } }),
    ).toBeUndefined();
    expect(
      readSourceSubgroupValue({ subgroupValue: ["array"] }),
    ).toBeUndefined();
  });
});

describe("cards a drag carries", () => {
  const selected = new Map([
    ["a", card("a")],
    ["b", card("b")],
    ["c", card("c")],
  ]);

  test("a selected card carries the whole selection, itself first", () => {
    expect(
      getDraggedItems(card("b"), selected).map((item) => item.entityId),
    ).toEqual(["b", "a", "c"]);
  });

  test("an unselected card carries only itself", () => {
    expect(
      getDraggedItems(card("z"), selected).map((item) => item.entityId),
    ).toEqual(["z"]);
  });

  test("a selection of one carries only the dragged card", () => {
    expect(
      getDraggedItems(card("a"), new Map([["a", card("a")]])).map(
        (item) => item.entityId,
      ),
    ).toEqual(["a"]);
  });
});

describe("marquee", () => {
  test("spans the same rectangle whichever way the pointer travels", () => {
    const expected = { left: 10, top: 20, right: 110, bottom: 220 };

    expect(getMarqueeRect({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual(
      expected,
    );
    expect(getMarqueeRect({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual(
      expected,
    );
    expect(getMarqueeRect({ x: 110, y: 20 }, { x: 10, y: 220 })).toEqual(
      expected,
    );
  });

  test("intersects a card it overlaps and misses one it only grazes", () => {
    const cardRect = { left: 100, top: 100, right: 300, bottom: 200 };

    expect(
      rectsIntersect({ left: 0, top: 0, right: 101, bottom: 101 }, cardRect),
    ).toBe(true);
    expect(
      rectsIntersect({ left: 0, top: 0, right: 100, bottom: 150 }, cardRect),
    ).toBe(false);
    expect(
      rectsIntersect({ left: 310, top: 0, right: 400, bottom: 400 }, cardRect),
    ).toBe(false);
    // A marquee drawn entirely inside a card still selects it.
    expect(
      rectsIntersect(
        { left: 150, top: 120, right: 160, bottom: 130 },
        cardRect,
      ),
    ).toBe(true);
  });

  test("does not start until the pointer travels past the click threshold", () => {
    expect(hasPassedMarqueeThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(
      false,
    );
    expect(hasPassedMarqueeThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(
      true,
    );
  });

  test("a plain marquee replaces the selection with what it touches", () => {
    const next = applyMarqueeSelection({
      base: { selectedIds: new Set(["old"]), anchorId: "old" },
      hitIds: ["a", "b"],
      mode: MARQUEE_MODE.replace,
    });

    expect([...next.selectedIds]).toEqual(["a", "b"]);
    expect(next.anchorId).toBeNull();
  });

  test("a modified marquee adds to the selection it started from", () => {
    const next = applyMarqueeSelection({
      base: { selectedIds: new Set(["old"]), anchorId: "old" },
      hitIds: ["a"],
      mode: MARQUEE_MODE.add,
    });

    expect([...next.selectedIds].toSorted()).toEqual(["a", "old"]);
    expect(next.anchorId).toBe("old");
  });
});

describe("scrollbar hits", () => {
  // A 300x200 column with a 1px border and a 12px scrollbar.
  const geometry = {
    rect: { left: 100, top: 50 },
    clientTop: 1,
    clientWidth: 286,
    clientHeight: 198,
  };

  test("a left-to-right scrollbar on the end edge is not client area", () => {
    const ltr = { ...geometry, clientLeft: 1 };

    expect(isInsideClientArea({ ...ltr, point: { x: 200, y: 100 } })).toBe(
      true,
    );
    expect(isInsideClientArea({ ...ltr, point: { x: 392, y: 100 } })).toBe(
      false,
    );
  });

  test("a right-to-left scrollbar on the start edge is not client area", () => {
    // Under dir="rtl" the scrollbar sits left and `clientLeft` includes it.
    const rtl = { ...geometry, clientLeft: 13 };

    expect(isInsideClientArea({ ...rtl, point: { x: 105, y: 100 } })).toBe(
      false,
    );
    expect(isInsideClientArea({ ...rtl, point: { x: 392, y: 100 } })).toBe(
      true,
    );
  });
});
