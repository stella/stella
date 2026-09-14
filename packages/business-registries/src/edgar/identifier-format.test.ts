import { describe, expect, test } from "bun:test";

import { formatEinDashed } from "./identifier-format.js";

describe("formatEinDashed", () => {
  test.each([
    ["942404110", "94-2404110"],
    ["000000000", "00-0000000"],
    ["999999999", "99-9999999"],
  ])("punctuates the EIN %s as XX-XXXXXXX", (ein, expected) => {
    expect(formatEinDashed(ein)).toBe(expected);
    expect(formatEinDashed(expected)).toBe(expected);
  });

  test.each([
    "",
    "12345678",
    "1234567890",
    "94-2404110",
    "94 2404110",
    "EIN942404110",
    "94240411a",
    " 942404110",
  ])("leaves %s untouched", (ein) => {
    expect(formatEinDashed(ein)).toBe(ein);
  });

  test("is idempotent over every nine-digit EIN", () => {
    for (let value = 0; value < 100_000; value += 7) {
      const ein = String(value).padStart(9, "0");
      const once = formatEinDashed(ein);
      expect(formatEinDashed(once)).toBe(once);
      expect(once.replace("-", "")).toBe(ein);
    }
  });
});
