import { describe, expect, test } from "bun:test";

import { readTargetIds, saveStateOf } from "@/features/avt/save-state.logic";

describe("per-item save indicator", () => {
  test("is idle until something touches the item", () => {
    expect(saveStateOf([{ targetIds: ["b"], status: "success" }], "a")).toBe(
      "idle",
    );
  });

  test("is saving while any save of the item is in flight", () => {
    expect(
      saveStateOf(
        [
          { targetIds: ["a"], status: "pending" },
          { targetIds: ["a", "b"], status: "success" },
        ],
        "a",
      ),
    ).toBe("saving");
  });

  test("reports the outcome of the latest save of the item", () => {
    expect(
      saveStateOf(
        [
          { targetIds: ["a"], status: "error" },
          { targetIds: ["a", "b"], status: "success" },
        ],
        "a",
      ),
    ).toBe("saved");
    expect(
      saveStateOf(
        [
          { targetIds: ["a"], status: "success" },
          { targetIds: ["a"], status: "error" },
        ],
        "a",
      ),
    ).toBe("failed");
  });

  test("reads target ids off untyped mutation variables", () => {
    expect(readTargetIds({ targetIds: ["a", 1, "b"] })).toEqual(["a", "b"]);
    expect(readTargetIds(undefined)).toEqual([]);
    expect(readTargetIds({ claimIds: ["a"] })).toEqual([]);
  });
});
