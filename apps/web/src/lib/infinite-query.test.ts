import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { visitCursorPages } from "./infinite-query";

describe("cursor page traversal", () => {
  test("visits every page in cursor order before requesting its successor", async () => {
    const events: string[] = [];
    await visitCursorPages({
      getPage: async (cursor) => {
        events.push(`get:${cursor ?? "first"}`);
        return cursor === undefined
          ? { items: [1, 2], nextCursor: "last" }
          : { items: [3], nextCursor: null };
      },
      visit: (page) => {
        events.push(`visit:${page.items.join(",")}`);
      },
    });
    expect(events).toEqual(["get:first", "visit:1,2", "get:last", "visit:3"]);
  });

  test("propagates an aborted page request without visiting it", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Traversal stopped", "AbortError");
    const cursors: (string | undefined)[] = [];
    const traversal = visitCursorPages({
      getPage: async (cursor) => {
        cursors.push(cursor);
        controller.signal.throwIfAborted();
        return { nextCursor: "next" };
      },
      visit: () => controller.abort(reason),
    });
    expect(await rejectionOf(traversal)).toBe(reason);
    expect(cursors).toEqual([undefined, "next"]);
  });
});
