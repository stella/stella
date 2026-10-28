import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WORKSPACE_VIEW_ID,
  isWorkspaceViewId,
  resolveWorkspaceViewParams,
} from "@/lib/workspaces/view-params.logic";

const filesViewId = "019a0000-0000-7000-8000-000000000202";

describe("the view a matter navigation opens under", () => {
  test("a destination in the matter on screen keeps the view it came from", () => {
    expect(
      resolveWorkspaceViewParams("matter-a", {
        workspaceId: "matter-a",
        viewId: filesViewId,
      }),
    ).toEqual({ workspaceId: "matter-a", viewId: filesViewId });
  });

  test("a destination in another matter opens under that matter's default view", () => {
    expect(
      resolveWorkspaceViewParams("matter-b", {
        workspaceId: "matter-a",
        viewId: filesViewId,
      }),
    ).toEqual({ workspaceId: "matter-b", viewId: DEFAULT_WORKSPACE_VIEW_ID });
  });

  test("a destination reached from outside any matter view opens under its default view", () => {
    expect(resolveWorkspaceViewParams("matter-a", undefined)).toEqual({
      workspaceId: "matter-a",
      viewId: DEFAULT_WORKSPACE_VIEW_ID,
    });
  });
});

describe("view id path segments", () => {
  test("a view UUID and the default slug are view ids", () => {
    expect(
      [filesViewId, filesViewId.toUpperCase(), DEFAULT_WORKSPACE_VIEW_ID].map(
        isWorkspaceViewId,
      ),
    ).toEqual([true, true, true]);
  });

  test("the matter's other path segments are not", () => {
    expect(
      ["reports", "correspondence", "workspaces", "", `${filesViewId}x`].map(
        isWorkspaceViewId,
      ),
    ).toEqual([false, false, false, false, false]);
  });
});
