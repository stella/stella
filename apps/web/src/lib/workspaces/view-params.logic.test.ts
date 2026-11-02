import { isNotFound } from "@tanstack/react-router";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { routeResourceResult } from "@/lib/errors/route-resource";
import {
  DEFAULT_WORKSPACE_VIEW_ID,
  isWorkspaceViewId,
  resolveWorkspaceViewParams,
  workspaceViewRouteIds,
  workspaceViewsInclude,
} from "@/lib/workspaces/view-params.logic";

const filesViewId = "019a0000-0000-7000-8000-000000000202";
const matterId = "019a0000-0000-7000-8000-000000000101";

// The `$viewId` loader's own check, run through the shared route resource.
const loadViewRoute = async (viewId: string) =>
  await routeResourceResult({
    ids: workspaceViewRouteIds(matterId, viewId),
    load: async () => [{ id: filesViewId }],
    exists: (views) => workspaceViewsInclude(views, viewId),
  });

describe("the matter views a $viewId URL opens", () => {
  test("the default slug opens the matter instead of the not-found page", async () => {
    const outcome = await loadViewRoute(DEFAULT_WORKSPACE_VIEW_ID);
    expect(Result.isOk(outcome)).toBe(true);
  });

  test("a view the matter has opens", async () => {
    const outcome = await loadViewRoute(filesViewId);
    expect(Result.isOk(outcome)).toBe(true);
  });

  test("a view the matter lacks is not found", async () => {
    const outcome = await loadViewRoute("019a0000-0000-7000-8000-000000000999");
    expect(Result.isError(outcome) && isNotFound(outcome.error)).toBe(true);
  });
});

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
