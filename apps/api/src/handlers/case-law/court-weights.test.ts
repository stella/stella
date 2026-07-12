import { describe, expect, test } from "bun:test";

import {
  courtWeightFromMap,
  flattenCourtWeightEntries,
} from "@/api/handlers/case-law/court-weights";
import type { CourtWeightMap } from "@/api/handlers/case-law/court-weights";

const buildMap = (): CourtWeightMap =>
  new Map([
    [
      "CZE",
      [
        {
          pattern: /ústavní soud/iu,
          tier: 4,
          tierLabel: "constitutional",
          weight: 10,
        },
        { pattern: /nejvyšší/iu, tier: 3, tierLabel: "supreme", weight: 8 },
      ],
    ],
    [
      "POL",
      [
        {
          pattern: /sąd najwyższy/iu,
          tier: 3,
          tierLabel: "supreme",
          weight: 8,
        },
      ],
    ],
  ]);

describe("courtWeightFromMap", () => {
  test("matches within the given country first", () => {
    const map = buildMap();
    expect(courtWeightFromMap(map, "Nejvyšší soud", "CZE")).toEqual({
      weight: 8,
      tier: 3,
    });
  });

  test("falls back across countries when no country given", () => {
    const map = buildMap();
    expect(courtWeightFromMap(map, "Sąd Najwyższy")).toEqual({
      weight: 8,
      tier: 3,
    });
  });

  test("falls back across countries when the named country has no match", () => {
    const map = buildMap();
    // A Polish court name, but caller passed the wrong country.
    expect(courtWeightFromMap(map, "Sąd Najwyższy", "CZE")).toEqual({
      weight: 8,
      tier: 3,
    });
  });

  test("unmatched court → default weight/tier 1", () => {
    const map = buildMap();
    expect(courtWeightFromMap(map, "Okresní soud")).toEqual({
      weight: 1,
      tier: 1,
    });
  });
});

describe("flattenCourtWeightEntries", () => {
  test("empty map → undefined (preserves courtWeightSql's legacy fallback)", () => {
    expect(flattenCourtWeightEntries(new Map())).toBeUndefined();
  });

  test("flattens entries across every country, sorted by tier descending", () => {
    const flattened = flattenCourtWeightEntries(buildMap());
    expect(flattened).toBeDefined();
    expect(flattened).toHaveLength(3);
    expect(flattened?.map((e) => e.tier)).toEqual([4, 3, 3]);
    // Both country's entries are present, not just the first country's.
    expect(flattened?.map((e) => e.tierLabel)).toContain("constitutional");
    expect(flattened?.filter((e) => e.tierLabel === "supreme")).toHaveLength(2);
  });
});
