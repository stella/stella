import { describe, expect, test } from "bun:test";

import { clampSearchLimit } from "./search.js";

describe("clampSearchLimit", () => {
  test("passes a requested limit within range through unchanged", () => {
    expect(clampSearchLimit(10, 100)).toBe(10);
  });

  test("clamps a requested limit above the ceiling down to the ceiling", () => {
    expect(clampSearchLimit(5000, 100)).toBe(100);
  });

  test("clamps a requested limit of zero or below up to 1", () => {
    expect(clampSearchLimit(0, 100)).toBe(1);
    expect(clampSearchLimit(-5, 100)).toBe(1);
  });

  test("returns the ceiling itself when requested equals the ceiling", () => {
    expect(clampSearchLimit(100, 100)).toBe(100);
  });
});
