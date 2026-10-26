import { describe, expect, test } from "bun:test";

import { resolveFullViewOriginView } from "@/components/inspector/file-full-view-navigation.logic";

describe("full document view origin", () => {
  test("a file from the matter on screen opens under the view it came from", () => {
    expect(
      resolveFullViewOriginView("matter-a", {
        workspaceId: "matter-a",
        viewId: "files-view",
      }),
    ).toEqual({ workspaceId: "matter-a", viewId: "files-view" });
  });

  test("a file from another matter opens under that matter's overview", () => {
    expect(
      resolveFullViewOriginView("matter-b", {
        workspaceId: "matter-a",
        viewId: "files-view",
      }),
    ).toEqual({ workspaceId: "matter-b", viewId: "all" });
  });

  test("a file opened outside any matter view opens under its overview", () => {
    expect(resolveFullViewOriginView("matter-a", undefined)).toEqual({
      workspaceId: "matter-a",
      viewId: "all",
    });
  });
});
