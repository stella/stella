import { expect, test } from "bun:test";

import {
  censusEntry,
  retainedCensusEntries,
} from "./seed-test-determinism-baselines.ts";

test("a scoped census retires missing paths without changing live budgets", () => {
  const reviewed = {
    "apps/web/keep.test.ts": {
      count: 2,
      owner: "web",
      reason: "native timer boundary",
    },
    "apps/web/selected.test.ts": {
      count: 3,
      owner: "web",
      reason: "selected for recount",
    },
    "apps/web/deleted.test.ts": {
      count: 9,
      owner: "web",
      reason: "retired test",
    },
  };
  expect([
    ...retainedCensusEntries({
      reviewed,
      selected: new Set(["apps/web/selected.test.ts"]),
      tracked: new Set(["apps/web/keep.test.ts", "apps/web/selected.test.ts"]),
    }),
  ]).toEqual([["apps/web/keep.test.ts", reviewed["apps/web/keep.test.ts"]]]);
  expect(reviewed["apps/web/keep.test.ts"].count).toBe(2);
});

test("a retained budget still requires reviewed metadata", () => {
  expect(() =>
    retainedCensusEntries({
      reviewed: {
        "apps/web/keep.test.ts": {
          count: "2",
          owner: "web",
          reason: "native timer boundary",
        },
      },
      selected: new Set(),
      tracked: new Set(["apps/web/keep.test.ts"]),
    }),
  ).toThrow("Invalid reviewed determinism entry");
});

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
