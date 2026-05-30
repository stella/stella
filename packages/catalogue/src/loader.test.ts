import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadCatalogueSkillInstallPayloads } from "./install-payloads";
import {
  filterCatalogueByKind,
  isToggleableNativeToolBackendSlug,
  loadCatalogue,
  loadRecommended,
  recommendedSlugsForJurisdictions,
} from "./loader";

describe("loadCatalogue", () => {
  it("loads the seeded native-tool entries", () => {
    const entries = loadCatalogue();
    const slugs = entries.map((entry) => entry.slug).sort();
    expect(slugs).toContain("ares");
    expect(slugs).toContain("boe");
    expect(slugs).toContain("infosoud");
    expect(slugs).toContain("web-search");
  });

  it("schema-validates every entry at load time", () => {
    const entries = loadCatalogue();
    for (const entry of entries) {
      expect(entry.slug).toBeString();
      expect(entry.license).toBeString();
      expect(["free", "paid"]).toContain(entry.cost);
      expect(["none", "account", "api-key"]).toContain(entry.setup);
    }
  });

  it("does not expose API-only skill payloads in the public catalogue", () => {
    const entries = loadCatalogue();
    for (const entry of entries) {
      expect("body" in entry).toBe(false);
      expect("resourceFiles" in entry).toBe(false);
    }

    const generated = readFileSync(
      path.join(import.meta.dirname, "catalogue.gen.ts"),
      "utf-8",
    );
    expect(generated).not.toContain("body:");
    expect(generated).not.toContain("resourceFiles");
  });
});

describe("loadCatalogueSkillInstallPayloads", () => {
  it("keeps private skill install payloads separate from public entries", () => {
    const payloadSlugs = new Set(
      loadCatalogueSkillInstallPayloads().map((payload) => payload.slug),
    );
    const skillEntries = loadCatalogue().filter(
      (entry) => entry.kind === "skill",
    );

    for (const entry of skillEntries) {
      expect(payloadSlugs.has(entry.slug)).toBe(true);
    }
  });
});

describe("filterCatalogueByKind", () => {
  it("narrows the result type per kind", () => {
    const nativeTools = filterCatalogueByKind("native-tool");
    expect(nativeTools.length).toBeGreaterThan(0);
    for (const tool of nativeTools) {
      expect(tool.kind).toBe("native-tool");
      // backendSlug is only present on native-tool, narrowing must work
      expect(tool.backendSlug).toBeString();
    }
  });
});

describe("isToggleableNativeToolBackendSlug", () => {
  it("tracks only native tools that are currently exposed to chat toggles", () => {
    expect(isToggleableNativeToolBackendSlug("ares")).toBe(true);
    expect(isToggleableNativeToolBackendSlug("brreg")).toBe(true);
    expect(isToggleableNativeToolBackendSlug("not-a-real-slug")).toBe(false);
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
});

describe("loadRecommended", () => {
  it("returns the JSON map with arrays of slugs", () => {
    const recommended = loadRecommended();
    expect(recommended["CZ"]).toBeArray();
    expect(recommended["ES"]).toBeArray();
  });
});
