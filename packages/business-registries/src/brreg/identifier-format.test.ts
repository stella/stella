import { describe, expect, test } from "bun:test";

import { formatBrregIdentifierSpaced } from "./identifier-format.js";

describe("formatBrregIdentifierSpaced", () => {
  test.each([
    ["923609016", "923 609 016"],
    ["974760673", "974 760 673"],
    ["000000000", "000 000 000"],
    ["999999999", "999 999 999"],
  ])("groups the orgnr %s as ddd ddd ddd", (orgnr, expected) => {
    expect(formatBrregIdentifierSpaced(orgnr)).toBe(expected);
    expect(formatBrregIdentifierSpaced(expected)).toBe(expected);
  });

  test.each([
    "",
    "12345678",
    "1234567890",
    "923 609 016",
    "NO923609016",
    "92360901a",
    " 923609016",
    "923609016 ",
  ])("leaves %s untouched", (identifier) => {
    expect(formatBrregIdentifierSpaced(identifier)).toBe(identifier);
  });

  test("is idempotent over every nine-digit identifier", () => {
    for (let value = 0; value < 100_000; value += 7) {
      const orgnr = String(value).padStart(9, "0");
      const once = formatBrregIdentifierSpaced(orgnr);
      expect(formatBrregIdentifierSpaced(once)).toBe(once);
      expect(once.replaceAll(" ", "")).toBe(orgnr);
    }
  });
});
