import { describe, expect, test } from "bun:test";

import {
  E2E_EXECUTION_PROFILE,
  partitionRoundRobin,
  resolveE2eExecutionProfile,
} from "../execution-profile";

describe("E2E execution profiles", () => {
  test("keeps the standard checks single-worker", () => {
    expect(resolveE2eExecutionProfile(undefined)).toEqual({
      routeSmokeGroupCount: 2,
      workerCount: 1,
    });
  });

  test("pairs two production workers with four independent route groups", () => {
    expect(
      resolveE2eExecutionProfile(E2E_EXECUTION_PROFILE.ciProductionParallel),
    ).toEqual({
      routeSmokeGroupCount: 4,
      workerCount: 2,
    });
  });

  test("rejects unknown profiles at the environment boundary", () => {
    expect(() => resolveE2eExecutionProfile("typo")).toThrow(
      "Unknown E2E execution profile: typo",
    );
  });
});

describe("round-robin route groups", () => {
  test("preserve every item exactly once with balanced group sizes", () => {
    for (let itemCount = 0; itemCount <= 64; itemCount += 1) {
      const items = Array.from({ length: itemCount }, (_, index) => index);
      for (let groupCount = 1; groupCount <= 8; groupCount += 1) {
        const groups = partitionRoundRobin(items, groupCount);
        const sizes = groups.map((group) => group.length);

        expect(groups).toHaveLength(groupCount);
        expect(groups.flat().toSorted((left, right) => left - right)).toEqual(
          items,
        );
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("rejects invalid group counts", () => {
    for (const groupCount of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => partitionRoundRobin([], groupCount)).toThrow(
        "E2E group count must be a positive safe integer",
      );
    }
  });
});
