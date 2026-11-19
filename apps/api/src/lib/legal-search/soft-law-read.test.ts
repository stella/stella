import { describe, expect, test } from "bun:test";

import { encodePaginationCursor } from "@/api/lib/pagination";

import { decodeSoftLawCursor, encodeSoftLawCursor } from "./soft-law-read";

describe("soft-law search cursor", () => {
  test("round-trips an offset the search can issue", () => {
    for (const offset of [0, 20, 1000]) {
      expect(decodeSoftLawCursor(encodeSoftLawCursor(offset))).toBe(offset);
    }
  });

  test("refuses a value it did not issue or an offset past the bound", () => {
    for (const value of [
      "",
      "20",
      "start",
      encodePaginationCursor([-1]),
      encodePaginationCursor([1.5]),
      encodePaginationCursor([1001]),
      encodePaginationCursor(["20"]),
    ]) {
      expect(decodeSoftLawCursor(value)).toBeNull();
    }
  });
});
