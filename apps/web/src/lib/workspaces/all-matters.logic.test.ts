import { expect, test } from "bun:test";

import { coversAllMatters } from "./all-matters.logic";

test("every matter, or more than the list still holds, covers all matters", () => {
  expect(coversAllMatters({ count: 3, total: 3 })).toBe(true);
  expect(coversAllMatters({ count: 4, total: 3 })).toBe(true);
  expect(coversAllMatters({ count: 1, total: 1 })).toBe(true);
});

test("a partial set or an empty matter list never reads as all matters", () => {
  expect(coversAllMatters({ count: 2, total: 3 })).toBe(false);
  expect(coversAllMatters({ count: 0, total: 3 })).toBe(false);
  expect(coversAllMatters({ count: 0, total: 0 })).toBe(false);
  expect(coversAllMatters({ count: 2, total: 0 })).toBe(false);
});
