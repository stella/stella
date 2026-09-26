import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { US_COURTS } from "@stll/api-contract/us-courts";

import { caseLawCourtWeights } from "@/api/db/schema";
import {
  COURT_PATTERN_MAX_LENGTH,
  COURT_WEIGHT_SEED,
  courtWeightEntriesFromSeed,
  courtWeightJurisdictionSeedSql,
  courtWeightMapFromSeed,
  courtWeightSeedSql,
  seededCourtWeightEntries,
  US_PATTERN_MAX_NAMES,
} from "@/api/handlers/case-law/court-weight-seed";
import {
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
} from "@/api/lib/legal-search/rerank";

const migrationPath = (directory: string) =>
  nodePath.resolve(
    import.meta.dir,
    "../../../drizzle",
    directory,
    "migration.sql",
  );

/**
 * Jurisdictions seeded by a migration of their own after the last full seed.
 * The full seed rendered the declaration without them, and each one's own
 * migration renders its rows alone.
 */
const SEEDED_AFTER_THE_FULL_SEED: ReadonlySet<string> = new Set(["USA"]);

/**
 * Jurisdictions whose enrolled courts include no constitutional court, so the
 * seed declares no constitutional rank for them.
 */
const WITHOUT_A_CONSTITUTIONAL_COURT: ReadonlySet<string> = new Set(["USA"]);

describe("court weight seed", () => {
  test("each seed migration is the rendering of its part of the declaration", async () => {
    const full = await Bun.file(
      migrationPath("20260918210100_case_law_court_weight_seed_hun"),
    ).text();
    const fullRows = COURT_WEIGHT_SEED.filter(
      (row) => !SEEDED_AFTER_THE_FULL_SEED.has(row.country),
    );
    expect(full.trimEnd().endsWith(courtWeightSeedSql(fullRows))).toBe(true);

    const usa = await Bun.file(
      migrationPath("20260926100100_case_law_court_weight_seed_usa"),
    ).text();
    expect(usa.trimEnd().endsWith(courtWeightJurisdictionSeedSql("USA"))).toBe(
      true,
    );
  });

  test("a jurisdiction's own seed names no other jurisdiction and removes nothing", () => {
    const rendered = courtWeightJurisdictionSeedSql("USA");
    expect(rendered.includes("DELETE")).toBe(false);
    const countries = [
      ...rendered.matchAll(/^ {2}\('(?<country>[A-Z]+)', /gmu),
    ].map((match) => match.groups?.["country"]);
    expect(countries.length).toBeGreaterThan(0);
    expect(countries).toEqual(countries.map(() => "USA"));
    expect(() => courtWeightJurisdictionSeedSql("XXX")).toThrow(
      "court weight seed declares no jurisdiction XXX",
    );
  });

  test("every jurisdiction declares a constitutional and a supreme rank", () => {
    const map = courtWeightMapFromSeed();
    expect([...map.keys()].toSorted()).toEqual([
      "AUT",
      "CZE",
      "EU",
      "HUN",
      "POL",
      "SVK",
      "USA",
    ]);
    for (const [country, entries] of map) {
      const labels = entries.map((entry) => entry.tierLabel);
      if (WITHOUT_A_CONSTITUTIONAL_COURT.has(country)) {
        expect(labels, country).not.toContain("constitutional");
      } else {
        expect(labels, country).toContain("constitutional");
      }
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
      ["POL", "Wojewódzki Sąd Administracyjny w Warszawie", "appeal"],
      ["POL", "Sąd Okręgowy w Warszawie", "regional"],
      ["POL", "Sąd Rejonowy w Gdańsku", "district"],
      ["POL", "Sąd Rejonowy dla Warszawy-Śródmieścia", "district"],
      ["POL", "Krajowa Izba Odwoławcza", "procurement-review"],
      ["AUT", "OGH", "supreme"],
      ["AUT", "VwGH", "supreme"],
      ["AUT", "VfGH", "constitutional"],
      ["AUT", "Verfassungsgerichtshof (VfGH)", "constitutional"],
      ["AUT", "Verwaltungsgerichtshof (VwGH)", "supreme"],
      ["HUN", "Alkotmánybíróság", "constitutional"],
      ["HUN", "Kúria", "supreme"],
      ["HUN", "Legfelsőbb Bíróság", "supreme"],
      ["HUN", "Fővárosi Ítélőtábla", "appeal"],
      ["HUN", "Fővárosi Törvényszék", "regional"],
      ["HUN", "Pest Megyei Bíróság", "regional"],
      [
        "HUN",
        "Fővárosi Közigazgatási és Munkaügyi Bíróság",
        "administrative-labour",
      ],
      ["HUN", "Pesti Központi Kerületi Bíróság", "district"],
      ["HUN", "Debreceni Járásbíróság", "district"],
      ["EU", "Court of Justice", "constitutional"],
      ["EU", "General Court", "supreme"],
      ["USA", "Supreme Court of the United States", "supreme"],
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
    // The SAOS feed and the Supreme Court connector store these court names;
    // a name two patterns both match would take whichever the precedence
    // order happens to reach first. The administrative pair is the close
    // one: only `naczelny` and `wojewódzki` separate the supreme row from
    // the appeal row.
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
        courtPattern: "sąd apelacyjny|wojewódzki sąd administracyjny",
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
      "Wojewódzki Sąd Administracyjny w Warszawie",
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

  test("Hungary ranks each stored name once, retired names included", () => {
    // Every rank is the kind of court, and the kinds share words: "fővárosi"
    // opens an appeal, a regional and an administrative-labour name alike, and
    // "bíróság" closes most of them. A name two patterns both matched would
    // take whichever precedence reached first.
    const hungarian = [
      "Alkotmánybíróság",
      "Kúria",
      "Legfelsőbb Bíróság",
      "Szegedi Ítélőtábla",
      "Fővárosi Ítélőtábla",
      "Fővárosi Törvényszék",
      "Pest Megyei Bíróság",
      "Fővárosi Közigazgatási és Munkaügyi Bíróság",
      "Pesti Központi Kerületi Bíróság",
      "Debreceni Járásbíróság",
    ];
    for (const court of hungarian) {
      const matched = seededCourtWeightEntries("HUN").filter((entry) =>
        entry.pattern.test(court),
      );
      expect([court, matched.length]).toEqual([court, 1]);
    }
  });

  test("the United States ranks every accepted court once, at its directory tier", () => {
    // Its decisions carry the directory's canonical court names, so each rank
    // is anchored to those spellings rather than to words other courts share.
    const rankOfTier = {
      supreme: { tier: 3, tierLabel: "supreme", weight: 8 },
      appellate: { tier: 2, tierLabel: "appeal", weight: 5 },
      trial: { tier: 1, tierLabel: "district", weight: 2 },
      special: { tier: 1, tierLabel: "special", weight: 3 },
    } as const;
    const entries = seededCourtWeightEntries("USA");
    const mismatched = US_COURTS.flatMap((court) => {
      const matched = entries
        .filter((entry) => entry.pattern.test(court.canonicalName))
        .map(({ tier, tierLabel, weight }) => ({ tier, tierLabel, weight }));
      return matched.length === 1 &&
        Bun.deepEquals(matched[0], rankOfTier[court.tier])
        ? []
        : [{ court: court.id, matched }];
    });
    expect(mismatched).toEqual([]);
    for (const court of [
      "Supreme Court of California",
      "United States Court of Appeals for the Ninth Circuit",
      "Supreme Court of the United States Virgin Islands",
    ]) {
      expect([
        court,
        seededCourtWeightEntries("USA").some((entry) =>
          entry.pattern.test(court),
        ),
      ]).toEqual([court, false]);
    }
  });

  test("United States patterns are anchored, bounded and fit the registry column", () => {
    expect(caseLawCourtWeights.courtPattern.getSQLType()).toBe(
      `varchar(${String(COURT_PATTERN_MAX_LENGTH)})`,
    );
    const usa = COURT_WEIGHT_SEED.filter((row) => row.country === "USA");
    // The one court that keeps a pattern of its own, spelled as before.
    expect(usa[0]).toEqual({
      country: "USA",
      courtPattern: "^supreme court of the united states$",
      tier: 3,
      tierLabel: "supreme",
      weight: 8,
    });
    for (const { courtPattern } of usa) {
      expect(courtPattern).toMatch(/^\^(?:\(\?:.*\))?.*\$$/u);
      expect(courtPattern.length).toBeLessThanOrEqual(COURT_PATTERN_MAX_LENGTH);
      expect(courtPattern.split(/(?<!\\)\|/u).length).toBeLessThanOrEqual(
        US_PATTERN_MAX_NAMES,
      );
    }
    // Every accepted name appears in exactly one pattern, and nothing else
    // does: the patterns are a partition of the directory's names.
    const alternatives = usa.flatMap(({ courtPattern }) =>
      courtPattern
        .replace(/^\^(?:\(\?:)?/u, "")
        .replace(/\)?\$$/u, "")
        .split(/(?<!\\)\|/u)
        .map((fragment) => fragment.replaceAll(/\\(.)/gu, "$1")),
    );
    expect(alternatives.toSorted()).toEqual(
      US_COURTS.map(({ canonicalName }) =>
        canonicalName.toLowerCase(),
      ).toSorted(),
    );
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
