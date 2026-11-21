import { describe, expect, test } from "bun:test";

import { planCombinationRun } from "@/api/tests/helpers/provider-request-matrix";

type Combination = readonly [string, string, string];

const DIMENSIONS = [
  ["a0", "a1", "a2", "a3", "a4"],
  ["b0", "b1", "b2", "b3"],
  ["c0", "c1", "c2"],
] as const;

/** Every combination but a few, as a named predicate would exclude them. */
const included: Combination[] = DIMENSIONS[0]
  .flatMap((a) =>
    DIMENSIONS[1].flatMap((b) =>
      DIMENSIONS[2].map((c): Combination => [a, b, c]),
    ),
  )
  .filter(([a, b]) => !(a === "a4" && b === "b3"));

const valuesOf = (combination: Combination) => combination;

const tuplesOf = (combinations: readonly Combination[], strength: 1 | 2) => {
  const tuples = new Set<string>();
  for (const combination of combinations) {
    for (const [first, value] of combination.entries()) {
      if (strength === 1) {
        tuples.add(`${String(first)}=${value}`);
        continue;
      }
      for (const [second, other] of combination.entries()) {
        if (second > first) {
          tuples.add(`${String(first)}=${value},${String(second)}=${other}`);
        }
      }
    }
  }
  return tuples;
};

describe("planCombinationRun", () => {
  test("the default pull-request cover takes every pair the included combinations take", () => {
    const plan = planCombinationRun({
      included,
      mode: undefined,
      shard: undefined,
      valuesOf,
    });
    expect(plan.mode).toBe("all-pairs");
    expect(tuplesOf(plan.runs, 2)).toEqual(tuplesOf(included, 2));
  });

  test("strength 1 takes every value of every dimension, in fewer runs than all-pairs", () => {
    const plan = planCombinationRun({
      included,
      mode: undefined,
      pullRequestStrength: 1,
      shard: undefined,
      valuesOf,
    });
    const pairs = planCombinationRun({
      included,
      mode: undefined,
      shard: undefined,
      valuesOf,
    });
    expect(plan.mode).toBe("each-value");
    expect(tuplesOf(plan.runs, 1)).toEqual(tuplesOf(included, 1));
    expect(plan.runs.length).toBeLessThan(pairs.runs.length);
    for (const run of plan.runs) {
      expect(included).toContainEqual(run);
    }
  });

  test("nightly modes ignore the pull-request strength", () => {
    const plan = planCombinationRun({
      included,
      mode: "all",
      pullRequestStrength: 1,
      shard: "0/1",
      valuesOf,
    });
    expect(plan.runs).toEqual(included);
  });
});
