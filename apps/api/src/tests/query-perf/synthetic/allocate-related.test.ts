import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { allocateRelatedRows } from "./allocate-related";

test("related allocations conserve the desired total within every workspace bound", () => {
  assertProperty(
    "related allocations conserve the desired total within every workspace bound",
    fc.property(
      fc.array(
        fc.record({
          feasible: fc.integer({ min: 0, max: 50 }),
          below: fc.integer({ min: 0, max: 50 }),
          above: fc.integer({ min: 0, max: 50 }),
        }),
        { minLength: 1, maxLength: 12 },
      ),
      (workspaces) => {
        const feasibleCounts = workspaces.map(({ feasible }) => feasible);
        const options = {
          desired: feasibleCounts.toReversed(),
          minimum: workspaces.map(({ feasible, below }) =>
            Math.max(0, feasible - below),
          ),
          maximum: workspaces.map(({ feasible, above }) => feasible + above),
        };
        const result = allocateRelatedRows(options);
        expect(result.reduce((sum, count) => sum + count, 0)).toBe(
          options.desired.reduce((sum, count) => sum + count, 0),
        );
        for (const [index, count] of result.entries()) {
          expect(count).toBeGreaterThanOrEqual(options.minimum.at(index) ?? 0);
          expect(count).toBeLessThanOrEqual(options.maximum.at(index) ?? 0);
        }
      },
    ),
  );
});

test("clamps desired rows and redistributes overflow proportionally by capacity", () => {
  expect(
    allocateRelatedRows({
      desired: [9, 1],
      minimum: [0, 0],
      maximum: [2, 8],
    }),
  ).toEqual([2, 8]);
  expect(
    allocateRelatedRows({
      desired: [0, 10],
      minimum: [2, 0],
      maximum: [8, 8],
    }),
  ).toEqual([2, 8]);
});

test("invalid or infeasible bounds fail before returning an allocation", () => {
  expect(() =>
    allocateRelatedRows({ desired: [1], minimum: [], maximum: [1] }),
  ).toThrow("Related row allocation arrays must have matching lengths");
  expect(() =>
    allocateRelatedRows({ desired: [-1], minimum: [0], maximum: [2] }),
  ).toThrow("Related row counts and bounds must be nonnegative safe integers");
  expect(() =>
    allocateRelatedRows({ desired: [1], minimum: [0], maximum: [Infinity] }),
  ).toThrow("Related row counts and bounds must be nonnegative safe integers");
  expect(() =>
    allocateRelatedRows({ desired: [1], minimum: [2], maximum: [1] }),
  ).toThrow("Related row minimum exceeds maximum");
  expect(() =>
    allocateRelatedRows({ desired: [1], minimum: [2], maximum: [3] }),
  ).toThrow("Related row allocation total is infeasible");
  expect(() =>
    allocateRelatedRows({ desired: [4], minimum: [0], maximum: [3] }),
  ).toThrow("Related row allocation total is infeasible");
});
