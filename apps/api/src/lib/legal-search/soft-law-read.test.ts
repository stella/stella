import { describe, expect, test } from "bun:test";

import {
  decodeSoftLawCursor,
  encodeSoftLawCursor,
  isSoftLawCursor,
} from "./soft-law-read";

describe("soft-law search cursor", () => {
  test("round-trips an offset the search can issue", () => {
    for (const offset of [0, 20, 1000]) {
      const cursor = encodeSoftLawCursor(offset);
      expect(isSoftLawCursor(cursor)).toBe(true);
      expect(decodeSoftLawCursor(cursor)).toBe(offset);
    }
  });

  test("refuses a value it did not issue or an offset past the bound", () => {
    for (const value of ["", "20", "start", "o", "o-1", "o1.5", "o1001"]) {
      expect(decodeSoftLawCursor(value)).toBeNull();
    }
  });
});
