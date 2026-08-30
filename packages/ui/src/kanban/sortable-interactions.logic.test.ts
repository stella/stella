import { describe, expect, test } from "bun:test";

import {
  getKanbanKeyboardTarget,
  isKanbanCellDropData,
} from "./sortable-interactions.logic";

const cells = [
  {
    id: "lane-0-column-0",
    itemIds: ["first", "second", "third"],
    position: { column: 0, lane: 0 },
    type: "kanban-cell",
  },
  {
    id: "lane-0-column-1",
    itemIds: [],
    position: { column: 1, lane: 0 },
    type: "kanban-cell",
  },
  {
    id: "lane-1-column-0",
    itemIds: ["fourth"],
    position: { column: 0, lane: 1 },
    type: "kanban-cell",
  },
  {
    id: "lane-1-column-1",
    itemIds: ["fifth", "sixth"],
    position: { column: 1, lane: 1 },
    type: "kanban-cell",
  },
] as const;

describe("Kanban keyboard navigation", () => {
  test("rejects invalid matrix positions at the drop boundary", () => {
    expect(
      isKanbanCellDropData({
        itemIds: [],
        position: { column: -1, lane: 0 },
        type: "kanban-cell",
      }),
    ).toBe(false);
  });

  test("preserves item order before leaving a cell", () => {
    expect(
      getKanbanKeyboardTarget({
        activeId: "first",
        cells,
        currentCellId: "lane-0-column-0",
        currentOverId: "first",
        direction: "down",
      }),
    ).toBe("second");
    expect(
      getKanbanKeyboardTarget({
        activeId: "first",
        cells,
        currentCellId: "lane-0-column-0",
        currentOverId: "second",
        direction: "down",
      }),
    ).toBe("third");
  });

  test("reaches empty cells and continues through a two-axis matrix", () => {
    expect(
      getKanbanKeyboardTarget({
        activeId: "first",
        cells,
        currentCellId: "lane-0-column-0",
        currentOverId: "first",
        direction: "right",
      }),
    ).toBe("lane-0-column-1");
    expect(
      getKanbanKeyboardTarget({
        activeId: "first",
        cells,
        currentCellId: "lane-0-column-1",
        currentOverId: "lane-0-column-1",
        direction: "down",
      }),
    ).toBe("fifth");
  });

  test("uses the nearest item index when crossing columns", () => {
    expect(
      getKanbanKeyboardTarget({
        activeId: "third",
        cells,
        currentCellId: "lane-1-column-1",
        currentOverId: "sixth",
        direction: "left",
      }),
    ).toBe("fourth");
  });
});
