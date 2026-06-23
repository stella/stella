import { describe, expect, test } from "bun:test";

import { dedupeById } from "@/lib/dedupe-by-id";

describe("dedupeById", () => {
  test("returns the same reference when all ids are unique", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    // Identity, not just equality: memoized consumers rely on the no-duplicate
    // common case staying referentially stable.
    expect(dedupeById(items)).toBe(items);
  });

  // Regression guard: during the per-turn refetch handoff the chat transcript
  // can hold the optimistic and persisted copies of one message, both with the
  // same id, which React renders twice. Dedupe must collapse them to one.
  test("collapses duplicate ids, keeping the last occurrence", () => {
    const first = { id: "x", v: 1 };
    const second = { id: "x", v: 2 };
    expect(dedupeById([first, second])).toEqual([second]);
  });

  test("preserves order using each id's last position", () => {
    const a1 = { id: "a", v: 1 };
    const b = { id: "b", v: 1 };
    const a2 = { id: "a", v: 2 };
    expect(dedupeById([a1, b, a2])).toEqual([b, a2]);
  });

  test("does not mutate the input", () => {
    const items = [{ id: "a" }, { id: "a" }];
    const snapshot = structuredClone(items);
    dedupeById(items);
    expect(items).toEqual(snapshot);
  });
});
