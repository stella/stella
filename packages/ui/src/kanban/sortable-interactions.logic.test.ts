import { describe, expect, test } from "bun:test";

import {
  clearKanbanKeyboardTarget,
  getKanbanKeyboardTargetState,
  getKanbanKeyboardTarget,
  isKanbanCellDropData,
  isKanbanDropSettled,
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

const publishedOver = (id: string) => ({
  data: { current: undefined },
  disabled: false,
  id,
  rect: { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 },
});

const navigatingItem = (current: {
  targetId: string;
  type: "pending" | "ready";
}) => ({
  data: { current: { navigation: { current }, type: "kanban-item" } },
  id: "first",
  rect: { current: { initial: null, translated: null } },
});

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

  test("holds a drop until the computed collision has been published", () => {
    expect(
      isKanbanDropSettled({
        active: null,
        collisions: [{ id: "lane-second" }, { id: "cell-c" }],
        over: publishedOver("whole-item"),
      }),
    ).toBe(false);
    expect(
      isKanbanDropSettled({
        active: null,
        collisions: [{ id: "lane-second" }, { id: "cell-c" }],
        over: publishedOver("lane-second"),
      }),
    ).toBe(true);
  });

  test("holds a drop while a virtual row is still being mounted", () => {
    // The board asked for an offscreen row, so the agreeing collision and
    // published target both describe where the drag has already left.
    expect(
      isKanbanDropSettled({
        active: navigatingItem({ targetId: "virtual-12", type: "pending" }),
        collisions: [{ id: "third" }],
        over: publishedOver("third"),
      }),
    ).toBe(false);
    expect(
      isKanbanDropSettled({
        active: navigatingItem({ targetId: "virtual-12", type: "ready" }),
        collisions: [{ id: "virtual-12" }],
        over: publishedOver("virtual-12"),
      }),
    ).toBe(true);
  });

  test("holds a navigated drop that the board has not published", () => {
    // A row that is briefly unmounted collides with nothing, which must not
    // read as the drag having left the board.
    expect(
      isKanbanDropSettled({
        active: navigatingItem({ targetId: "third", type: "ready" }),
        collisions: [],
        over: null,
      }),
    ).toBe(false);
  });

  test("settles a drop when nothing is under the drag", () => {
    expect(
      isKanbanDropSettled({ active: null, collisions: [], over: null }),
    ).toBe(true);
    expect(
      isKanbanDropSettled({ active: null, collisions: null, over: null }),
    ).toBe(true);
    expect(
      isKanbanDropSettled({
        active: null,
        collisions: [],
        over: publishedOver("first"),
      }),
    ).toBe(false);
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
