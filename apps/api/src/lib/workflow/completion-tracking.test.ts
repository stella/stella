import { describe, expect, test } from "bun:test";

import { parseEntityCompletionReply } from "@/api/lib/workflow/completion-tracking";

describe("parseEntityCompletionReply", () => {
  test("reads a matched increment", () => {
    expect(parseEntityCompletionReply([1, 3, 10])).toEqual({
      matched: true,
      completed: 3,
      total: 10,
    });
  });

  test("treats an unmatched request as unmatched", () => {
    // A stale job's requestId no longer equals the workspace's current
    // request-id (or running lock): the Lua script returns [0, 0, 0]
    // without touching the counters. This is the case that used to be a
    // separate, racy `isCurrentWorkflowRequest` check before the INCR.
    expect(parseEntityCompletionReply([0, 0, 0])).toEqual({ matched: false });
  });

  test("treats a non-array reply as unmatched", () => {
    expect(parseEntityCompletionReply(null)).toEqual({ matched: false });
    expect(parseEntityCompletionReply(undefined)).toEqual({
      matched: false,
    });
    expect(parseEntityCompletionReply("OK")).toEqual({ matched: false });
  });

  test("treats a short array as unmatched", () => {
    expect(parseEntityCompletionReply([1, 3])).toEqual({ matched: false });
  });

  test("treats non-numeric completed/total as unmatched", () => {
    expect(parseEntityCompletionReply([1, "x", 10])).toEqual({
      matched: false,
    });
    expect(parseEntityCompletionReply([1, 3, "y"])).toEqual({
      matched: false,
    });
  });

  test("treats a matched flag other than 1 as unmatched", () => {
    expect(parseEntityCompletionReply([2, 3, 10])).toEqual({
      matched: false,
    });
  });
});
