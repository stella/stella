import { describe, expect, test } from "bun:test";

import {
  isWorkspaceViewLayoutType,
  workspaceCalendarModes,
  workspaceTimelineZoomLevels,
  workspaceViewLayoutTypes,
  type WorkspaceSavedView,
  type WorkspaceTimelineViewLayout,
} from "./views";

describe("workspace saved-view model", () => {
  test("publishes each shared layout discriminator exactly once", () => {
    expect(new Set(workspaceViewLayoutTypes).size).toBe(
      workspaceViewLayoutTypes.length,
    );
    expect(workspaceViewLayoutTypes).toEqual([
      "table",
      "kanban",
      "calendar",
      "timeline",
    ]);
  });

  test("recognizes only shared entity layouts", () => {
    for (const type of workspaceViewLayoutTypes) {
      expect(isWorkspaceViewLayoutType(type)).toBe(true);
    }
    expect(isWorkspaceViewLayoutType("overview")).toBe(false);
    expect(isWorkspaceViewLayoutType("filesystem")).toBe(false);
  });

  test("keeps calendar and timeline modes finite", () => {
    expect(workspaceCalendarModes).toEqual(["month", "week", "year"]);
    expect(workspaceTimelineZoomLevels).toEqual([
      "day",
      "week",
      "month",
      "quarter",
    ]);
  });

  test("uses the persisted timeline table contract", () => {
    const timeline = {
      calculations: [],
      endDatePropertyId: "end",
      filters: [],
      hiddenProperties: [],
      showTable: true,
      sorts: [],
      startDatePropertyId: "start",
      type: "timeline",
      version: 1,
      zoom: "month",
    } satisfies WorkspaceTimelineViewLayout;

    expect(timeline.showTable).toBe(true);
  });

  test("threads numeric property identifiers through every view reference", () => {
    const view = {
      createdAt: "2026-01-01T00:00:00.000Z",
      id: 1,
      layout: {
        calculations: [{ kind: "count", propertyId: 11 }],
        columnOrder: [11, 12],
        columnPinning: [11],
        filters: [
          {
            operand: { propertyId: 12, type: "property" },
            op: "is_not_empty",
            type: "predicate",
          },
        ],
        groupByPropertyId: 13,
        hiddenProperties: [14],
        sorts: [{ desc: false, propertyId: 15 }],
        type: "table",
        version: 1,
      },
      name: "Numeric property identifiers",
      position: 0,
      version: 1,
    } satisfies WorkspaceSavedView<number, number>;

    expect(view.layout.filters.at(0)?.operand).toEqual({
      propertyId: 12,
      type: "property",
    });
  });
});
