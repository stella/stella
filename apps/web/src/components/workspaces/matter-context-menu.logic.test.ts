import { describe, expect, test } from "bun:test";

import { matterMenuLifecycle } from "./matter-context-menu.logic";

describe("matter lifecycle actions", () => {
  test("archived matters offer only Unarchive and require restoration before deletion", () => {
    expect(matterMenuLifecycle(true)).toEqual({
      action: "unarchive",
      editing: "read-only",
      deletion: "unarchive-first",
    });
  });

  test("active matters offer only Archive and allow deletion", () => {
    expect(matterMenuLifecycle(false)).toEqual({
      action: "archive",
      editing: "editable",
      deletion: "allowed",
    });
  });
});
