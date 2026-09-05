import { describe, expect, test } from "bun:test";

import { createChatToolDefectMemo } from "./tool-defect-memo";

describe("createChatToolDefectMemo", () => {
  test("reports a recorded tool+args pair and nothing else", () => {
    const memo = createChatToolDefectMemo();
    memo.recordDefect("list_matters", { matter_id: "mat_1" });

    expect(memo.isKnownDefect("list_matters", { matter_id: "mat_1" })).toBe(
      true,
    );
    expect(memo.isKnownDefect("list_matters", { matter_id: "mat_2" })).toBe(
      false,
    );
    expect(memo.isKnownDefect("list_documents", { matter_id: "mat_1" })).toBe(
      false,
    );
    expect(memo.isKnownDefect("list_matters", {})).toBe(false);
  });

  test("keying is insensitive to argument object key order", () => {
    const memo = createChatToolDefectMemo();
    memo.recordDefect("list_tasks", { matter_id: "mat_1", limit: 10 });

    // The model re-emitting the same call with reordered keys is the same
    // call; a key-order-sensitive memo would let the retry through.
    expect(
      memo.isKnownDefect("list_tasks", { limit: 10, matter_id: "mat_1" }),
    ).toBe(true);
  });

  test("a fresh memo knows nothing (turn-scoped, no shared state)", () => {
    const first = createChatToolDefectMemo();
    first.recordDefect("get_usage", {});

    const second = createChatToolDefectMemo();
    expect(second.isKnownDefect("get_usage", {})).toBe(false);
  });
});
