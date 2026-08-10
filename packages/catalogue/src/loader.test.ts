import { describe, expect, it } from "bun:test";

import { loadCatalogue, recommendedSlugsForJurisdictions } from "./loader";

describe("loadCatalogue", () => {
  it("does not expose API-only skill payloads in the public catalogue", () => {
    const entries = loadCatalogue();
    for (const entry of entries) {
      expect("body" in entry).toBe(false);
      expect("resourceFiles" in entry).toBe(false);
    }
  });
});

describe("recommendedSlugsForJurisdictions", () => {
  it("returns ARES for CZ practice", () => {
    const slugs = recommendedSlugsForJurisdictions(new Set(["CZ"]));
    expect(slugs.has("ares")).toBe(true);
  });

  it("unions multi-jurisdiction picks and dedupes", () => {
    const czSk = recommendedSlugsForJurisdictions(new Set(["CZ", "SK"]));
    const cz = recommendedSlugsForJurisdictions(new Set(["CZ"]));
    for (const slug of cz) {
      expect(czSk.has(slug)).toBe(true);
    }
  });

  it("returns nothing for jurisdictions with no entries", () => {
    const slugs = recommendedSlugsForJurisdictions(new Set(["JP"]));
    expect(slugs.size).toBe(0);
  });

  it("activates the EU wildcard tier (VIES) for any EU member practice", () => {
    // FR is a member but has no per-country entry in recommended.json;
    // the EU wildcard should still surface VIES.
    expect(recommendedSlugsForJurisdictions(new Set(["FR"])).has("vies")).toBe(
      true,
    );
    expect(recommendedSlugsForJurisdictions(new Set(["CZ"])).has("vies")).toBe(
      true,
    );
  });

  it("does not surface the EU wildcard tier for non-EU practices", () => {
    expect(recommendedSlugsForJurisdictions(new Set(["JP"])).has("vies")).toBe(
      false,
    );
    expect(recommendedSlugsForJurisdictions(new Set(["NO"])).has("vies")).toBe(
      false,
    );
  });
});
