import { describe, expect, test } from "bun:test";

import {
  normalizeOptionalArray,
  optionalArray,
  optionalReadonlyArray,
} from "./arrays";

describe("normalizeOptionalArray", () => {
  test("returns the array unchanged when populated", () => {
    expect(normalizeOptionalArray([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("returns [] for an empty array", () => {
    expect(normalizeOptionalArray([])).toEqual([]);
  });

  test("returns [] for undefined", () => {
    expect(normalizeOptionalArray(undefined)).toEqual([]);
  });
});

describe("optionalArray", () => {
  test("returns the array unchanged when populated", () => {
    expect(optionalArray(["a", "b"])).toEqual(["a", "b"]);
  });

  test("returns [] for an empty array", () => {
    expect(optionalArray([])).toEqual([]);
  });

  test("returns [] for null", () => {
    expect(optionalArray(null)).toEqual([]);
  });

  test("returns [] for undefined", () => {
    expect(optionalArray(undefined)).toEqual([]);
  });
});

describe("optionalReadonlyArray", () => {
  test("returns the array unchanged when populated", () => {
    expect(optionalReadonlyArray([10, 20])).toEqual([10, 20]);
  });

  test("returns [] for an empty readonly array", () => {
    expect(optionalReadonlyArray([])).toEqual([]);
  });

  test("returns [] for null", () => {
    expect(optionalReadonlyArray(null)).toEqual([]);
  });

  test("returns [] for undefined", () => {
    expect(optionalReadonlyArray(undefined)).toEqual([]);
  });
});
