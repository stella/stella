import { describe, expect, test } from "bun:test";

import { normalizeRegisteredCompanyName } from "@/api/lib/business-registries/company-name";

describe("registered company name normalization", () => {
  test.each([
    ["Żółć sp. z o.o.", "zolc"],
    ["„ŻÓŁĆ” SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", "zolc"],
    ["Zażółć Gęślą S.A.", "zazolc gesla"],
    ["Zażółć Gęślą spółka akcyjna", "zazolc gesla"],
    ["Kowalski i Wspólnicy sp.k.", "kowalski i wspolnicy"],
    ["Kowalski i Wspólnicy SPÓŁKA KOMANDYTOWA", "kowalski i wspolnicy"],
    ["Kowalski—Nowak SP.J.", "kowalski nowak"],
    ["  'Acme'   Polska  ", "acme polska"],
  ])("normalizes %s", (input, expected) => {
    expect(String(normalizeRegisteredCompanyName(input))).toBe(expected);
  });

  test.each(["sp. z o.o.", "S.A."])(
    "rejects a suffix-only name: %s",
    (input) => {
      expect(normalizeRegisteredCompanyName(input)).toBeNull();
    },
  );
});
