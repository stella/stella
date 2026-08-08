import { describe, expect, test } from "bun:test";

import { reorderViewIds, toViewDropPosition } from "./view-switcher.logic";

const IDS = ["overview", "table", "files", "kanban", "calendar"] as const;
const POSITIONS = ["before", "after"] as const;

describe("view tab reordering", () => {
  test("lands the dragged view beside the target on the requested side", () => {
    for (const draggedId of IDS) {
      for (const targetId of IDS) {
        for (const position of POSITIONS) {
          const reordered = reorderViewIds({
            ids: IDS,
            draggedId,
            targetId,
            position,
          });
          // A drop that changes nothing reports `null`; the order on screen
          // then stands, and must satisfy the same invariant.
          const order = reordered ?? [...IDS];

          expect([...order].sort()).toEqual([...IDS].sort());

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

  test("reports no change when the view already sits on that side", () => {
    expect(
      reorderViewIds({
        ids: IDS,
        draggedId: "table",
        targetId: "overview",
        position: "after",
      }),
    ).toBeNull();
    expect(
      reorderViewIds({
        ids: IDS,
        draggedId: "table",
        targetId: "files",
        position: "before",
      }),
    ).toBeNull();
  });

  test("ignores views that are not in the list", () => {
    expect(
      reorderViewIds({
        ids: IDS,
        draggedId: "deleted-elsewhere",
        targetId: "table",
        position: "before",
      }),
    ).toBeNull();
    expect(
      reorderViewIds({
        ids: IDS,
        draggedId: "table",
        targetId: "deleted-elsewhere",
        position: "before",
      }),
    ).toBeNull();
  });
});

describe("drop edge resolution", () => {
  test("mirrors the trailing edge under rtl", () => {
    expect(toViewDropPosition("right", "ltr")).toBe("after");
    expect(toViewDropPosition("left", "ltr")).toBe("before");
    expect(toViewDropPosition("right", "rtl")).toBe("before");
    expect(toViewDropPosition("left", "rtl")).toBe("after");
  });

  test("ignores edges off the inline axis", () => {
    expect(toViewDropPosition("top", "ltr")).toBeNull();
    expect(toViewDropPosition("bottom", "ltr")).toBeNull();
    expect(toViewDropPosition(null, "ltr")).toBeNull();
  });
});
