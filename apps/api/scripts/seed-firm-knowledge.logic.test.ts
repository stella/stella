import { describe, expect, test } from "bun:test";

import { selectMatterNames } from "./seed-firm-knowledge.logic";

const MATTERS = Array.from(
  { length: 25 },
  (_, index) => `matter-${String(index + 1).padStart(2, "0")}`,
);

describe("selectMatterNames", () => {
  test("selects an exact, unique, reproducible seeded subset", () => {
    const selection = selectMatterNames({
      matterCount: 10,
      matterNames: MATTERS,
      selectionSeed: "quick-start-seed",
    });
    const repeated = selectMatterNames({
      matterCount: 10,
      matterNames: MATTERS.toReversed(),
      selectionSeed: "quick-start-seed",
    });

    expect(selection).toEqual(repeated);
    expect(selection).toHaveLength(10);
    expect(new Set(selection).size).toBe(10);
    expect(selection.every((matter) => MATTERS.includes(matter))).toBe(true);
  });

  test("does not mutate the manifest and never invents missing matters", () => {
    const source = ["matter-c", "matter-a", "matter-b", "matter-a"];
    const snapshot = [...source];

    const selection = selectMatterNames({
      matterCount: 10,
      matterNames: source,
      selectionSeed: "small-corpus",
    });

    expect(source).toEqual(snapshot);
    expect(new Set(selection)).toEqual(
      new Set(["matter-a", "matter-b", "matter-c"]),
    );
  });

  test("preserves the CLI's alphabetical selection without a seed", () => {
    expect(
      selectMatterNames({ matterCount: 2, matterNames: ["c", "a", "b"] }),
    ).toEqual(["a", "b"]);
  });
});
