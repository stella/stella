import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { iterateCursorPages, visitCursorPages } from "./infinite-query";

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

test("a visitor can stop at its cap without fetching the remaining cursor", async () => {
  const cursors: (string | undefined)[] = [];
  const visited: number[] = [];
  await visitCursorPages({
    getPage: async (cursor) => {
      cursors.push(cursor);
      return {
        items: [1, 2],
        nextCursor: cursor === undefined ? "unread" : null,
      };
    },
    visit: (page) => {
      visited.push(...page.items);
    },
    shouldContinue: () => visited.length < 2,
  });
  expect(cursors).toEqual([undefined]);
  expect(visited).toEqual([1, 2]);
});

test("cursor streams preserve numeric offsets and consumer backpressure", async () => {
  const cursors: number[] = [];
  const stream = iterateCursorPages({
    initialCursor: 0,
    getPage: async (cursor) => {
      cursors.push(cursor);
      return {
        text: cursor === 0 ? "first" : "second",
        next: cursor === 0 ? 7 : null,
      };
    },
    getNextCursor: (page) => page.next,
  });
  expect(cursors).toEqual([]);
  expect(await stream.next()).toEqual({
    value: { text: "first", next: 7 },
    done: false,
  });
  expect(cursors).toEqual([0]);
  expect(await stream.next()).toEqual({
    value: { text: "second", next: null },
    done: false,
  });
  expect(cursors).toEqual([0, 7]);
  await stream.return(undefined);
  expect(cursors).toEqual([0, 7]);
});

test("closing a cursor stream leaves its successor unread", async () => {
  const cursors: number[] = [];
  const stream = iterateCursorPages({
    initialCursor: 0,
    getPage: async (cursor) => {
      cursors.push(cursor);
      return { next: cursor + 1 };
    },
    getNextCursor: (page) => page.next,
  });
  await stream.next();
  await stream.return(undefined);
  expect(cursors).toEqual([0]);
});
