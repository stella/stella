import { expect, test } from "bun:test";

import { censusEntry } from "./seed-test-determinism-baselines.ts";

test("recounts occurrences while preserving reviewed ownership and reason", () => {
  const reviewed = {
    count: 10,
    owner: "database",
    reason: "compares against the Postgres clock",
  };
  const first = censusEntry({
    file: "apps/api/x.test.ts",
    current: undefined,
    reviewed,
  });
  expect(first).toEqual({ ...reviewed, count: 1 });
  expect(
    censusEntry({ file: "apps/api/x.test.ts", current: first, reviewed }),
  ).toEqual({ ...reviewed, count: 2 });
  expect(reviewed.count).toBe(10);
});

test("assigns defaults only to a new census entry", () => {
  expect(
    censusEntry({
      file: "apps/api/x.test.ts",
      current: undefined,
      reviewed: undefined,
    }),
  ).toEqual({
    count: 1,
    owner: "api",
    reason: "pre-kit census; migrate to @stll/test-kit",
  });
});
