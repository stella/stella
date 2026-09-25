import { describe, expect, test } from "bun:test";

import {
  getCurrentWorkspaceViewId,
  getWorkspaceFolderNavigationTarget,
} from "@/components/chat/folder-navigation";
import type { WorkspaceView } from "@/lib/types";

const view = (id: string, type: WorkspaceView["layout"]["type"]) => ({
  id,
  layout: { type },
});

describe("folder navigation", () => {
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

  test("opens the file tree, not the first view, and reveals the folder", () => {
    expect(
      getWorkspaceFolderNavigationTarget({
        folderId: "folder_1",
        pathname: "/chat",
        targetWorkspaceId: "ws_1",
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
      getWorkspaceFolderNavigationTarget({
        folderId: "folder_1",
        pathname: "/workspaces/ws_1/overview",
        targetWorkspaceId: "ws_1",
        views: [view("overview", "overview"), view("files", "filesystem")],
      }).params.viewId,
    ).toBe("files");
  });

  test("stays on the current tree view when there are several", () => {
    expect(
      getWorkspaceFolderNavigationTarget({
        folderId: "folder_1",
        pathname: "/workspaces/ws_1/files-2/document",
        targetWorkspaceId: "ws_1",
        views: [view("files-1", "filesystem"), view("files-2", "filesystem")],
      }).params.viewId,
    ).toBe("files-2");
  });

  test("scopes the current view into the folder when there is no tree", () => {
    expect(
      getWorkspaceFolderNavigationTarget({
        folderId: "folder_1",
        pathname: "/chat",
        targetWorkspaceId: "ws_1",
        views: [view("overview", "overview")],
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { viewId: "all", workspaceId: "ws_1" },
      search: { folder: "folder_1" },
    });
  });
});
