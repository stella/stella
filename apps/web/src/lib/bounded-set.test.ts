import { describe, expect, test } from "bun:test";

import { BoundedMap, BoundedSet } from "./bounded-set";

describe("bounded session deduplication", () => {
  test("evicts the least recently added value at capacity", () => {
    const values = new BoundedSet<string>(2);
    for (const value of ["first", "second", "first", "third"]) {
      values.add(value);
    }

    expect(values.has("first")).toBeTrue();
    expect(values.has("second")).toBeFalse();
    expect(values.has("third")).toBeTrue();
  });
});

describe("bounded caches", () => {
  test("evicts the least recently written entry at capacity", () => {
    const values = new BoundedMap<string, number>(2);
    const writes = [
      ["first", 1],
      ["second", 2],
      ["first", 3],
      ["third", 4],
    ] as const;
    for (const [key, value] of writes) {
      values.set(key, value);
    }

    expect(values.get("first")).toBe(3);
    expect(values.get("second")).toBeUndefined();
    expect(values.get("third")).toBe(4);
  });
});
