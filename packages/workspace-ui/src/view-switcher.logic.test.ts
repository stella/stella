import { describe, expect, test } from "bun:test";

import {
  reorderWorkspaceViewIds,
  toWorkspaceViewDropPosition,
} from "./view-switcher.logic";

const IDS = ["overview", "table", "files", "kanban", "calendar"] as const;
const POSITIONS = ["before", "after"] as const;

describe("workspace view reordering", () => {
  test("keeps every view exactly once and lands beside the target", () => {
    for (const draggedId of IDS) {
      for (const targetId of IDS) {
        for (const position of POSITIONS) {
          const reordered = reorderWorkspaceViewIds({
            ids: IDS,
            draggedId,
            targetId,
            position,
          });
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

  test("returns null for no-op and stale identities", () => {
    expect(
      reorderWorkspaceViewIds({
        ids: IDS,
        draggedId: "table",
        targetId: "overview",
        position: "after",
      }),
    ).toBeNull();
    expect(
      reorderWorkspaceViewIds({
        ids: IDS,
        draggedId: "deleted",
        targetId: "table",
        position: "before",
      }),
    ).toBeNull();
  });

  test("mirrors physical edges in rtl", () => {
    expect(toWorkspaceViewDropPosition("right", "ltr")).toBe("after");
    expect(toWorkspaceViewDropPosition("left", "ltr")).toBe("before");
    expect(toWorkspaceViewDropPosition("right", "rtl")).toBe("before");
    expect(toWorkspaceViewDropPosition("left", "rtl")).toBe("after");
    expect(toWorkspaceViewDropPosition("top", "ltr")).toBeNull();
  });
});
