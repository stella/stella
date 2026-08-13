import { describe, expect, test } from "bun:test";

import { suggestedCountryCodes } from "@/lib/jurisdictions";

describe("jurisdiction suggestions", () => {
  test("ranks detected country, browser region, then email country", () => {
    expect(
      suggestedCountryCodes({
        browserRegion: "PT",
        detectedCountry: "CZ",
        email: "lawyer@example.de",
      }),
    ).toEqual(["CZ", "PT", "DE"]);
  });

  test("deduplicates equivalent country signals", () => {
    expect(
      suggestedCountryCodes({
        browserRegion: "pt",
        detectedCountry: "PT",
        email: "lawyer@example.pt",
      }),
    ).toEqual(["PT"]);
  });

  test("does not infer a country from a regionless UI locale", () => {
    expect(
      suggestedCountryCodes({
        email: "lawyer@example.com",
      }),
    ).toEqual([]);
  });
});
