import { describe, expect, test } from "bun:test";

import { matterMenuLifecycle } from "./matter-context-menu.logic";

describe("matter lifecycle actions", () => {
  test("archived matters offer only Unarchive and require restoration before deletion", () => {
    expect(matterMenuLifecycle(true, true)).toEqual({
      action: "unarchive",
      editing: "read-only",
      deletion: "unarchive-first",
    });
  });

  test("active matters offer only Archive and allow deletion", () => {
    expect(matterMenuLifecycle(false, true)).toEqual({
      action: "archive",
      editing: "editable",
      deletion: "allowed",
    });
  });

  test("read-only members cannot archive or unarchive matters", () => {
    expect(matterMenuLifecycle(false, false).action).toBe("none");
    expect(matterMenuLifecycle(true, false).action).toBe("none");
  });
});
