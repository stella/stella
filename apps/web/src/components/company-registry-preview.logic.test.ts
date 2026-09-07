import { describe, expect, test } from "bun:test";

import { parseRegistryCalendarDate } from "./company-registry-preview.logic";

describe("registry calendar dates", () => {
  test("keeps the same source day for date-only and timestamp representations", () => {
    for (const day of [
      "2023-10-27",
      "2024-02-29",
      "2024-03-31",
      "2024-10-27",
    ]) {
      const expected = parseRegistryCalendarDate(day);
      expect(expected).not.toBeNull();
      for (const suffix of [
        "T00:00:00",
        "T00:00:00.0000000",
        "T00:00:00Z",
        "T00:00:00+14:00",
        "T23:59:59-12:00",
      ]) {
        expect(parseRegistryCalendarDate(`${day}${suffix}`)).toEqual(expected);
      }
    }
  });

  test("rejects impossible dates and malformed timestamps", () => {
    for (const value of [
      "",
      "Sro 61675/N",
      "2023-02-29",
      "2023-02-29T00:00:00",
      "2023-10-27T24:00:00",
      "2023-10-27T00:99:00",
      "2023-10-27garbage",
    ]) {
      expect(parseRegistryCalendarDate(value)).toBeNull();
    }
  });
});
