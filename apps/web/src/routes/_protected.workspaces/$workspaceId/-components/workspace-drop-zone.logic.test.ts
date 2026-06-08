import { describe, expect, test } from "bun:test";

import { resolveWorkspaceDropUploadParentId } from "./workspace-drop-zone.logic";

describe("workspace drop upload parent", () => {
  test("uses the current folder while dropping onto a filesystem folder view", () => {
    expect(
      resolveWorkspaceDropUploadParentId({
        activeViewLayoutType: "filesystem",
        currentFolderId: "entity_folder",
      }),
    ).toBe("entity_folder");
  });

  test("keeps filesystem root drops at root", () => {
    expect(
      resolveWorkspaceDropUploadParentId({
        activeViewLayoutType: "filesystem",
        currentFolderId: undefined,
      }),
    ).toBeNull();
  });

  test("ignores stale folder params outside filesystem views", () => {
    expect(
      resolveWorkspaceDropUploadParentId({
        activeViewLayoutType: "table",
        currentFolderId: "entity_folder",
      }),
    ).toBeNull();
  });
});
