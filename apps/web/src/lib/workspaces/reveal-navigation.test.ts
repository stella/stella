import { describe, expect, test } from "bun:test";

import type { WorkspaceView } from "@/lib/types";
import {
  getCurrentWorkspaceViewId,
  getWorkspaceRevealTarget,
} from "@/lib/workspaces/reveal-navigation";

const view = (
  id: string,
  type: WorkspaceView["layout"]["type"],
  filters: WorkspaceView["layout"]["filters"] = [],
) => ({ id, layout: { type, filters } });

const someFilter: WorkspaceView["layout"]["filters"] = [
  { type: "group", combinator: "and", children: [] },
];

const folderReveal = {
  entityId: "folder_1",
  fallbackFolderId: "folder_1",
  pathname: "/chat",
  targetWorkspaceId: "ws_1",
};

describe("reveal navigation", () => {
  test("reads the active view id from workspace paths", () => {
    expect(getCurrentWorkspaceViewId("/workspaces/ws_1/files", "ws_1")).toBe(
      "files",
    );
  });

  test("ignores paths outside the target workspace", () => {
    expect(getCurrentWorkspaceViewId("/chat", "ws_1")).toBeNull();
    expect(
      getCurrentWorkspaceViewId("/workspaces/ws_2/files", "ws_1"),
    ).toBeNull();
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

  test("opens the tree at its root when there is nothing to reveal", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        entityId: null,
        views: [view("files", "filesystem")],
      }).search,
    ).toEqual({});
  });

  test("leaves an overview view for the file tree", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        pathname: "/workspaces/ws_1/overview",
        views: [view("overview", "overview"), view("files", "filesystem")],
      }).params.viewId,
    ).toBe("files");
  });

  test("stays on the current tree view when there are several", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        pathname: "/workspaces/ws_1/files-2/document",
        views: [view("files-1", "filesystem"), view("files-2", "filesystem")],
      }).params.viewId,
    ).toBe("files-2");
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

  test("scopes the current view into the fallback folder when there is no tree", () => {
    expect(
      getWorkspaceRevealTarget({
        ...folderReveal,
        entityId: "doc_1",
        views: [view("overview", "overview")],
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { viewId: "all", workspaceId: "ws_1" },
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
