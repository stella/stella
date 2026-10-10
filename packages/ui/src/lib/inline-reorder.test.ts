import { describe, expect, test } from "bun:test";

import { reorderInlineIds, toInlineDropPosition } from "./inline-reorder";

const IDS = ["overview", "table", "files", "kanban", "calendar"] as const;
const POSITIONS = ["before", "after"] as const;

describe("inline reordering", () => {
  test("keeps every view exactly once and lands beside the target", () => {
    for (const draggedId of IDS) {
      for (const targetId of IDS) {
        for (const position of POSITIONS) {
          const reordered = reorderInlineIds({
            ids: IDS,
            draggedId,
            targetId,
            position,
          });
          const order = reordered ?? [...IDS];

          expect([...order].toSorted()).toEqual([...IDS].toSorted());

          if (draggedId === targetId) {
            expect(reordered).toBeNull();
            continue;
          }

          expect(order.indexOf(draggedId)).toBe(
            order.indexOf(targetId) + (position === "after" ? 1 : -1),
          );
        }
      }
    }
  });

  test("returns null for no-op and stale identities", () => {
    expect(
      reorderInlineIds({
        ids: IDS,
        draggedId: "table",
        targetId: "overview",
        position: "after",
      }),
    ).toBeNull();
    expect(
      reorderInlineIds({
        ids: IDS,
        draggedId: "deleted",
        targetId: "table",
        position: "before",
      }),
    ).toBeNull();
  });

  test("mirrors physical edges in rtl", () => {
    expect(toInlineDropPosition("right", "ltr")).toBe("after");
    expect(toInlineDropPosition("left", "ltr")).toBe("before");
    expect(toInlineDropPosition("right", "rtl")).toBe("before");
    expect(toInlineDropPosition("left", "rtl")).toBe("after");
    expect(toInlineDropPosition("top", "ltr")).toBeNull();
  });
});
