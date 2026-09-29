import { describe, expect, test } from "bun:test";

import { loadCatalogue } from "@stll/catalogue";

import {
  classifyToolEntry,
  resolveToolEntry,
} from "@/lib/knowledge/tool-entry";

const SKILL_IDS = [
  "550e8400-e29b-41d4-a716-446655440000",
  "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D",
];

const CATALOGUE_SLUGS = loadCatalogue().map(({ slug }) => slug);

const INVALID = ["", "Sanctions", "two words", "../tools", "slug-", "-slug"];

/** A catalogue lookup that records every slug it is asked for. */
const recordingLookup = () => {
  const asked: string[] = [];
  return {
    asked,
    loadCatalogueDetail: async (slug: string) => {
      asked.push(slug);
      await Promise.resolve();
      return { slug };
    },
  };
};

describe("classifyToolEntry", () => {
  test("a skill id reads as a skill", () => {
    for (const id of SKILL_IDS) {
      expect(classifyToolEntry(id)).toBe("skill");
    }
  });

  test("every bundled catalogue slug reads as the catalogue", () => {
    expect(CATALOGUE_SLUGS.length).toBeGreaterThan(0);
    for (const slug of CATALOGUE_SLUGS) {
      expect(classifyToolEntry(slug)).toBe("catalogue");
    }
  });

  test("anything else names neither", () => {
    for (const entry of INVALID) {
      expect(classifyToolEntry(entry)).toBe("invalid");
    }
  });
});

describe("resolveToolEntry", () => {
  test("a skill id opens the skill and is never looked up in the catalogue", async () => {
    for (const catalogueServed of [true, false]) {
      const lookup = recordingLookup();
      for (const id of SKILL_IDS) {
        expect(
          await resolveToolEntry(id, { catalogueServed, ...lookup }),
        ).toEqual({ page: "skill", skillId: id });
      }
      expect(lookup.asked).toEqual([]);
    }
  });

  test("a slug opens the catalogue page and never the skill", async () => {
    const lookup = recordingLookup();
    for (const slug of CATALOGUE_SLUGS) {
      const page = await resolveToolEntry(slug, {
        catalogueServed: true,
        ...lookup,
      });
      expect(page).toEqual({ page: "catalogue", detail: { slug } });
    }
    expect(lookup.asked).toEqual(CATALOGUE_SLUGS);
  });

  test("where the catalogue is not served, a slug is not found and not looked up", async () => {
    const lookup = recordingLookup();
    for (const slug of CATALOGUE_SLUGS) {
      expect(
        await resolveToolEntry(slug, { catalogueServed: false, ...lookup }),
      ).toEqual({ page: "missing" });
    }
    expect(lookup.asked).toEqual([]);
  });

  test("a slug the catalogue lacks is not found", async () => {
    expect(
      await resolveToolEntry("no-such-tool", {
        catalogueServed: true,
        loadCatalogueDetail: async () => {
          await Promise.resolve();
          return null;
        },
      }),
    ).toEqual({ page: "missing" });
  });

  test("an invalid entry is not found and not looked up", async () => {
    const lookup = recordingLookup();
    for (const entry of INVALID) {
      expect(
        await resolveToolEntry(entry, { catalogueServed: true, ...lookup }),
      ).toEqual({ page: "missing" });
    }
    expect(lookup.asked).toEqual([]);
  });
});
