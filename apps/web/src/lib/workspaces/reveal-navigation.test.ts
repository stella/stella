import { describe, expect, test } from "bun:test";

import type { WorkspaceView } from "@/lib/types";
import { getWorkspaceRevealTarget } from "@/lib/workspaces/reveal-navigation";
import { DEFAULT_WORKSPACE_VIEW_ID } from "@/lib/workspaces/view-params.logic";

const view = (
  id: string,
  type: WorkspaceView["layout"]["type"],
  filters: WorkspaceView["layout"]["filters"] = [],
) => ({ id, layout: { type, filters } });

const someFilter: WorkspaceView["layout"]["filters"] = [
  { type: "group", combinator: "and", children: [] },
];

const overviewId = "019a0000-0000-7000-8000-000000000401";
const filesId = "019a0000-0000-7000-8000-000000000402";
const otherFilesId = "019a0000-0000-7000-8000-000000000403";

const folderReveal = {
  currentView: undefined,
  entityId: "folder_1",
  fallbackFolderId: "folder_1",
  targetWorkspaceId: "ws_1",
};

describe("reveal navigation", () => {
  test("scopes into the view on screen when the matter has no tree", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        currentView: { workspaceId: "ws_1", viewId: overviewId },
        views: [view(overviewId, "overview")],
      }).params,
    ).toEqual({ workspaceId: "ws_1", viewId: overviewId });
  });

  test("a view on screen in another matter, or none, is not kept", () => {
    expect(
      [{ workspaceId: "ws_2", viewId: otherFilesId }, undefined].map(
        (currentView) =>
          getWorkspaceRevealTarget({
            ...folderReveal,
            currentView,
            views: [
              view(filesId, "filesystem"),
              view(otherFilesId, "filesystem"),
            ],
          }).params.viewId,
      ),
    ).toEqual([filesId, filesId]);
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        currentView: { workspaceId: "ws_2", viewId: overviewId },
        views: [view(overviewId, "overview")],
      }).params.viewId,
    ).toBe(DEFAULT_WORKSPACE_VIEW_ID);
  });

  test("opens the file tree, not the first view, and reveals the entity", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        views: [view("overview", "overview"), view("files", "filesystem")],
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { viewId: "files", workspaceId: "ws_1" },
      search: { reveal: "folder_1" },
    });
  });

  test("leaves an overview view for the file tree", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        currentView: { workspaceId: "ws_1", viewId: overviewId },
        views: [view(overviewId, "overview"), view(filesId, "filesystem")],
      }).params.viewId,
    ).toBe(filesId);
  });

  test("stays on the current tree view when there are several", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        currentView: { workspaceId: "ws_1", viewId: otherFilesId },
        views: [view(filesId, "filesystem"), view(otherFilesId, "filesystem")],
      }).params.viewId,
    ).toBe(otherFilesId);
  });

  test("prefers an unfiltered tree, whose filters cannot hide the entity", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        views: [
          view("filtered", "filesystem", someFilter),
          view("unfiltered", "filesystem"),
        ],
      }).params.viewId,
    ).toBe("unfiltered");
  });

  test("still opens a filtered tree when it is the only one", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        views: [view("filtered", "filesystem", someFilter)],
      }).params.viewId,
    ).toBe("filtered");
  });

  test("scopes the default view into the fallback folder when there is no tree and no view on screen", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        entityId: "doc_1",
        views: [view("overview", "overview")],
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { viewId: DEFAULT_WORKSPACE_VIEW_ID, workspaceId: "ws_1" },
      search: { folder: "folder_1" },
    });
  });

  test("opens the matter root when there is no tree and no folder", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        fallbackFolderId: null,
        views: [view("overview", "overview")],
      }).search,
    ).toEqual({});
  });
});
