import { describe, expect, test } from "bun:test";

import {
  isWorkspaceViewLayoutType,
  workspaceCalendarModes,
  workspaceTimelineTableModes,
  workspaceTimelineZoomLevels,
  workspaceViewLayoutTypes,
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
    expect(workspaceTimelineTableModes).toEqual(["hidden", "visible"]);
  });
});
