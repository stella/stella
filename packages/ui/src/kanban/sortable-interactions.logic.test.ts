import { describe, expect, test } from "bun:test";

import {
  clearKanbanKeyboardTarget,
  getKanbanKeyboardTargetState,
  getKanbanKeyboardTarget,
  isKanbanCellDropData,
} from "./sortable-interactions.logic";

const cells = [
  {
    id: "lane-0-column-0",
    itemIds: ["first", "second", "third"],
    navigation: { type: "static" },
    position: { column: 0, lane: 0 },
    type: "kanban-cell",
  },
  {
    id: "lane-0-column-1",
    itemIds: [],
    navigation: { type: "static" },
    position: { column: 1, lane: 0 },
    type: "kanban-cell",
  },
  {
    id: "lane-1-column-0",
    itemIds: ["fourth"],
    navigation: { type: "static" },
    position: { column: 0, lane: 1 },
    type: "kanban-cell",
  },
  {
    id: "lane-1-column-1",
    itemIds: ["fifth", "sixth"],
    navigation: { type: "static" },
    position: { column: 1, lane: 1 },
    type: "kanban-cell",
  },
] as const;

describe("Kanban keyboard navigation", () => {
  test("keeps a stable navigation holder across virtual renders", () => {
    const navigation = {
      current: { targetId: "offscreen", type: "pending" },
    };
    const data = { navigation, type: "kanban-item" };

    expect(getKanbanKeyboardTargetState(data)).toEqual({
      targetId: "offscreen",
      type: "pending",
    });
    clearKanbanKeyboardTarget(data);

    expect(data.navigation).toBe(navigation);
    expect(getKanbanKeyboardTargetState(data)).toEqual({ type: "idle" });
  });

  test("rejects invalid matrix positions at the drop boundary", () => {
    expect(
      isKanbanCellDropData({
        itemIds: [],
        navigation: { type: "static" as const },
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
