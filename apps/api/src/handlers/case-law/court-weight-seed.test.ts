import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { courtAbbreviation } from "@stll/api-contract/case-law-court-abbreviations";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { US_COURTS } from "@stll/api-contract/us-courts";

import {
  COURT_WEIGHT_SEED,
  courtWeightEntriesFromSeed,
  courtWeightJurisdictionSeedSql,
  courtWeightMapFromSeed,
  courtWeightSeedSql,
  seededCourtWeightEntries,
  type CourtWeightSeedRow,
} from "@/api/handlers/case-law/court-weight-seed";
import { SK_ECLI_COURTS } from "@/api/lib/case-law/ecli-court-codes";
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

// The merged full seed retains the Slovak declaration it originally shipped.
const HISTORICAL_SVK_SEED = [
  {
    country: "SVK",
    courtPattern: "ústavný súd",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "SVK",
    courtPattern: "najvyšší",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "SVK",
    courtPattern: "krajský súd",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },
] satisfies CourtWeightSeedRow[];

describe("court weight seed", () => {
  test("each seed migration is the rendering of its part of the declaration", async () => {
    const full = await Bun.file(
      migrationPath("20260918210100_case_law_court_weight_seed_hun"),
    ).text();
    const fullRows = COURT_WEIGHT_SEED.filter(
      (row) => !SEEDED_AFTER_THE_FULL_SEED.has(row.country),
    ).flatMap((row) => {
      if (row.country !== "SVK") {
        return [row];
      }
      return row.courtPattern === "ústavný súd" ? HISTORICAL_SVK_SEED : [];
    });
    expect(full.trimEnd().endsWith(courtWeightSeedSql(fullRows))).toBe(true);

    const usa = await Bun.file(
      migrationPath("20260927200200_case_law_court_weight_seed_usa"),
    ).text();
    expect(usa.trimEnd().endsWith(courtWeightJurisdictionSeedSql("USA"))).toBe(
      true,
    );
    const svk = await Bun.file(
      migrationPath("20261003122700_case_law_court_weight_seed_svk"),
    ).text();
    expect(svk.trimEnd().endsWith(courtWeightJurisdictionSeedSql("SVK"))).toBe(
      true,
    );
  });

  test("the flat seed keeps the jurisdiction order the migrations rendered", () => {
    // The migrations above pin row order within the full seed; this pins
    // where each jurisdiction's block sits, USA last, as the declaration
    // map's entry order must keep it.
    expect([...new Set(COURT_WEIGHT_SEED.map((row) => row.country))]).toEqual([
      "CZE",
      "SVK",
      "POL",
      "AUT",
      "HUN",
      "EU",
      "USA",
    ]);
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
    const stored: readonly [
      country: CaseLawJurisdiction,
      court: string,
      label: string,
    ][] = [
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

  test("Slovakia ranks every court family once, including retired names", () => {
    const families: readonly [court: string, label: string, tier: number][] = [
      ["Ústavný súd Slovenskej republiky", "constitutional", 4],
      ["Najvyšší súd Slovenskej republiky", "supreme", 3],
      ["Najvyšší správny súd Slovenskej republiky", "supreme", 3],
      ["Krajský súd v Bratislave", "regional", 2],
      ["Okresný súd Bratislava I", "district", 1],
      ["Mestský súd Bratislava I", "district", 1],
      ["Mestský súd Košice", "district", 1],
      ["Správny súd v Bratislave", "administrative", 1],
      ["Správny súd v Banskej Bystrici", "administrative", 1],
      ["Správny súd v Košiciach", "administrative", 1],
      ["Špecializovaný trestný súd", "special", 1],
      ["Špeciálny súd", "special", 1],
    ];
    for (const [court, tierLabel, tier] of families) {
      const matches = seededCourtWeightEntries("SVK").filter((entry) =>
        entry.pattern.test(court),
      );
      expect(matches, court).toHaveLength(1);
      expect(matches.at(0), court).toMatchObject({ tierLabel, tier });
      if (tierLabel !== "supreme") {
        continue;
      }
      for (const space of ["  ", "\u00a0"]) {
        const spaced = court.replaceAll(" ", () => space);
        expect(spaced).not.toBe(court);
        const spacedMatches = seededCourtWeightEntries("SVK").filter((entry) =>
          entry.pattern.test(spaced),
        );
        expect(spacedMatches, spaced).toHaveLength(1);
        expect(spacedMatches.at(0), spaced).toMatchObject({ tierLabel, tier });
      }
    }
  });

  test("every declared Slovak ECLI court has one rank and an abbreviation", () => {
    for (const [code, court] of Object.entries(SK_ECLI_COURTS)) {
      const matches = seededCourtWeightEntries("SVK").filter((entry) =>
        entry.pattern.test(court),
      );
      expect(matches, code).toHaveLength(1);
      expect(
        courtAbbreviation({
          country: "SVK",
          court: "",
          ecli: `ECLI:SK:${code}:2024:1.1`,
        }),
        code,
      ).toBeDefined();
    }
    expect(
      courtAbbreviation({
        country: "SVK",
        court: "",
        ecli: "ECLI:SK:SpSBA:2024:1.1",
      }),
    ).toBe("SpS");
    expect(
      courtAbbreviation({
        country: "SVK",
        court: "",
        ecli: "ECLI:SK:SSPK:2024:1.1",
      }),
    ).toBe("ŠTS");
  });

  test("the United States keeps its one legacy name row and names no other court", () => {
    // USA decisions rank by court id, so the registry holds only the row its
    // seed migration wrote, anchored so no other court's name matches it.
    const entries = seededCourtWeightEntries("USA");
    expect(
      US_COURTS.filter((court) =>
        entries.some((entry) => entry.pattern.test(court.canonicalName)),
      ).map(({ id }) => id),
    ).toEqual(["scotus"]);
    expect(COURT_WEIGHT_SEED.filter((row) => row.country === "USA")).toEqual([
      {
        country: "USA",
        courtPattern: "^supreme court of the united states$",
        tier: 3,
        tierLabel: "supreme",
        weight: 8,
      },
    ]);
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
