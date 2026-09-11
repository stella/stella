import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import {
  COURT_WEIGHT_SEED,
  courtWeightEntriesFromSeed,
  courtWeightMapFromSeed,
  courtWeightSeedSql,
  seededCourtWeightEntries,
} from "@/api/handlers/case-law/court-weight-seed";
import {
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
} from "@/api/lib/legal-search/rerank";

const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260911140000_case_law_court_weight_seed_pol/migration.sql",
);

describe("court weight seed", () => {
  test("the seed migration is the rendering of the declaration", async () => {
    const migration = await Bun.file(MIGRATION).text();
    expect(migration.trimEnd().endsWith(courtWeightSeedSql())).toBe(true);
  });

  test("every jurisdiction declares a constitutional and a supreme rank", () => {
    const map = courtWeightMapFromSeed();
    expect([...map.keys()].toSorted()).toEqual([
      "AUT",
      "CZE",
      "EU",
      "POL",
      "SVK",
    ]);
    for (const [country, entries] of map) {
      const labels = entries.map((entry) => entry.tierLabel);
      expect(labels, country).toContain("constitutional");
      expect(labels, country).toContain("supreme");
      expect(entries.map((entry) => entry.tier)).toEqual(
        entries.map((entry) => entry.tier).toSorted((a, b) => b - a),
      );
    }
  });

  test("court names as the adapters store them rank where the seed intends", () => {
    // The stored spellings, taken from the adapters' fixtures: full names,
    // bracketed abbreviations, bare abbreviations. A spelling the seed misses
    // silently demotes a supreme court to a district court.
    const stored: readonly [country: string, court: string, label: string][] = [
      ["CZE", "Ústavní soud", "constitutional"],
      ["CZE", "Nejvyšší soud", "supreme"],
      ["CZE", "Nejvyšší správní soud", "supreme"],
      ["CZE", "Krajský soud v Brně", "regional"],
      ["SVK", "Najvyšší súd Slovenskej republiky", "supreme"],
      ["SVK", "Najvyšší správny súd Slovenskej republiky", "supreme"],
      ["SVK", "Ústavný súd Slovenskej republiky", "constitutional"],
      ["POL", "Sąd Najwyższy", "supreme"],
      ["POL", "Naczelny Sąd Administracyjny", "supreme"],
      ["POL", "Trybunał Konstytucyjny", "constitutional"],
      ["POL", "Sąd Apelacyjny w Krakowie", "appeal"],
      ["POL", "Sąd Okręgowy w Warszawie", "regional"],
      ["POL", "Sąd Rejonowy w Gdańsku", "district"],
      ["POL", "Sąd Rejonowy dla Warszawy-Śródmieścia", "district"],
      ["POL", "Krajowa Izba Odwoławcza", "procurement-review"],
      ["AUT", "OGH", "supreme"],
      ["AUT", "VwGH", "supreme"],
      ["AUT", "VfGH", "constitutional"],
      ["AUT", "Verfassungsgerichtshof (VfGH)", "constitutional"],
      ["AUT", "Verwaltungsgerichtshof (VwGH)", "supreme"],
      ["EU", "Court of Justice", "constitutional"],
      ["EU", "General Court", "supreme"],
    ];
    for (const [country, court, label] of stored) {
      const entry = seededCourtWeightEntries(country).find((candidate) =>
        candidate.pattern.test(court),
      );
      expect([country, court, entry?.tierLabel]).toEqual([
        country,
        court,
        label,
      ]);
    }
  });

  test("Poland ranks every instance the feeds store, each pattern once", () => {
    // The SAOS feed and the Supreme Court connector store these six court
    // names; a name two patterns both match would take whichever the
    // precedence order happens to reach first.
    expect(COURT_WEIGHT_SEED.filter((row) => row.country === "POL")).toEqual([
      {
        country: "POL",
        courtPattern: "trybunał konstytucyjny",
        tier: 4,
        tierLabel: "constitutional",
        weight: 10,
      },
      {
        country: "POL",
        courtPattern: "sąd najwyższy|naczelny sąd administracyjny",
        tier: 3,
        tierLabel: "supreme",
        weight: 8,
      },
      {
        country: "POL",
        courtPattern: "sąd apelacyjny",
        tier: 2,
        tierLabel: "appeal",
        weight: 5,
      },
      {
        country: "POL",
        courtPattern: "sąd okręgowy",
        tier: 2,
        tierLabel: "regional",
        weight: 4,
      },
      {
        country: "POL",
        courtPattern: "krajowa izba odwoławcza",
        tier: 1,
        tierLabel: "procurement-review",
        weight: 3,
      },
      {
        country: "POL",
        courtPattern: "sąd rejonowy",
        tier: 1,
        tierLabel: "district",
        weight: 2,
      },
    ]);
    const polish = [
      "Trybunał Konstytucyjny",
      "Sąd Najwyższy",
      "Sąd Apelacyjny w Krakowie",
      "Sąd Okręgowy w Warszawie",
      "Krajowa Izba Odwoławcza",
      "Sąd Rejonowy dla Warszawy-Śródmieścia",
    ];
    for (const court of polish) {
      const matched = seededCourtWeightEntries("POL").filter((entry) =>
        entry.pattern.test(court),
      );
      expect([court, matched.length]).toEqual([court, 1]);
    }
  });

  test("the seeded tiers stay inside the range the search blend scales", () => {
    // `courtTierValue` maps this range onto [0, 1]. A seed row outside it
    // would clamp, silently flattening two ranks into one prior.
    for (const row of COURT_WEIGHT_SEED) {
      expect([
        row.country,
        row.courtPattern,
        row.tier >= LOWEST_COURT_TIER,
      ]).toEqual([row.country, row.courtPattern, true]);
      expect([
        row.country,
        row.courtPattern,
        row.tier <= HIGHEST_COURT_TIER,
      ]).toEqual([row.country, row.courtPattern, true]);
    }
    // The top of the scale is a rank something actually holds, so the tier
    // prior's full weight is reachable.
    expect(Math.max(...COURT_WEIGHT_SEED.map((row) => row.tier))).toBe(
      HIGHEST_COURT_TIER,
    );
  });

  test("patterns are unique per jurisdiction and compile case-insensitively", () => {
    const keys = COURT_WEIGHT_SEED.map(
      (row) => `${row.country}:${row.courtPattern}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const entries = courtWeightEntriesFromSeed();
    expect(entries).toHaveLength(COURT_WEIGHT_SEED.length);
    expect(entries.every((entry) => entry.pattern.flags.includes("i"))).toBe(
      true,
    );
  });
});
