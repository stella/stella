import { describe, expect, test } from "bun:test";

import {
  getCurrentWorkspaceViewId,
  getWorkspaceFolderNavigationTarget,
} from "@/components/chat/folder-navigation";

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

  test("keeps the folder target when falling back to the default view", () => {
    expect(
      getWorkspaceFolderNavigationTarget({
        folderId: "folder_1",
        pathname: "/chat",
        targetWorkspaceId: "ws_1",
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { viewId: "all", workspaceId: "ws_1" },
      search: { folder: "folder_1" },
    });
  });
});
