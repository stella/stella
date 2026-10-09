import { describe, expect, test } from "bun:test";

import { createRandomValue, createUuid } from "./uuid";

describe("web-owned UUID generation", () => {
  test("creates unique version 7 UUIDs", () => {
    const values = Array.from({ length: 100 }, createUuid);

    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(value.at(14)).toBe("7");
    }
  });

  test("creates unique full-entropy hexadecimal values", () => {
    const values = Array.from({ length: 100 }, createRandomValue);

    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toHaveLength(32);
      expect(value).toMatch(/^[0-9a-f]+$/u);
    }
  });
});
