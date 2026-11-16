import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CZ_ECLI_COURT_REGISTRY } from "@stll/api-contract/case-law-courts";
import {
  directoryCourtAliases,
  foldCourtText,
} from "@stll/api-contract/court-citation-aliases";
import {
  courtCitationGrammarOf,
  type DirectoryCourt,
} from "@stll/api-contract/court-citation-directory";
import { assertProperty } from "@stll/property-testing";

import { CASE_LAW_SURFACE_COUNTRIES } from "@/api/lib/case-law/public-subject";
import {
  combineCourtFilters,
  readCourtFilter,
  type StoredCourtCatalog,
  storedCourtCatalog,
} from "@/api/mcp/case-law-court-filter";

/**
 * Court names as the identity countries' publishers store them beside the
 * directory's official names: apex courts with and without the country, a
 * regional court and its branches in the nominative, and Slovak seats
 * written without their preposition. Read off the corpus's own court list.
 */
const PUBLISHER_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  CZE: [
    "Nejvyšší soud České republiky",
    "Krajský soud v Ústí nad Labem, pobočka Liberec",
    "Krajský soud v Hradci Králové – pobočka v Pardubicích",
    "Krajský soud v Brně, pobočka Jihlava",
  ],
  SVK: [
    "Najvyšší súd",
    "Najvyšší správny súd SR",
    "Krajský súd Prešov",
    "Okresný súd Košice-okolie",
  ],
  POL: ["Sąd Rejonowy dla Warszawy-Śródmieścia w Warszawie"],
  HUN: ["Legfelsőbb Bíróság"],
  EU: [],
};

const IDENTITY_COUNTRIES = CASE_LAW_SURFACE_COUNTRIES.identity;

type CountryCourt = {
  country: string;
  court: DirectoryCourt;
  aliases: readonly string[];
};

const directoryCourtsOf = (country: string): readonly CountryCourt[] =>
  (
    courtCitationGrammarOf(country)?.courts ??
    panic(`No court citation grammar for ${country}`)
  ).map((court) => ({
    country,
    court,
    aliases: directoryCourtAliases(country, court),
  }));

const ALL_COURTS = IDENTITY_COUNTRIES.flatMap(directoryCourtsOf);

/** The corpus as the filter sees it when every directory court holds decisions. */
const fullCatalog = (country: string): StoredCourtCatalog =>
  storedCourtCatalog(
    country,
    directoryCourtsOf(country).map(({ court }) => court.name),
  );

const FULL_CATALOGS = new Map(
  IDENTITY_COUNTRIES.map((country) => [country, fullCatalog(country)]),
);

const catalogOf = (country: string): StoredCourtCatalog =>
  FULL_CATALOGS.get(country) ?? panic(`No catalog for ${country}`);

/**
 * Every spelling a court is cited by: its aliases and its ECLI codes. A
 * one-letter code (the EU's `C`, `T`) is a court only inside an ECLI, as the
 * resolver reads it too.
 */
const citedFormsOf = ({ court, aliases }: CountryCourt): readonly string[] => [
  ...aliases,
  ...court.ecliCodes.filter((code) => code.length > 1),
];

/** A branch's main court: the directory court of the same head and seat. */
const mainCourtOf = (country: string, branch: DirectoryCourt) =>
  directoryCourtsOf(country).find(
    ({ court }) =>
      court.branch === undefined &&
      court.head === branch.head &&
      court.seat?.nominative === branch.seat?.nominative,
  ) ?? panic(`No main court for ${branch.name}`);

const BRANCHES = ALL_COURTS.filter(({ court }) => court.branch !== undefined);

describe("court filters read a court through the resolver's court identity", () => {
  test("every identity country declares directory courts the filter reads", () => {
    expect(IDENTITY_COUNTRIES.length).toBeGreaterThan(0);
    for (const country of IDENTITY_COUNTRIES) {
      expect(directoryCourtsOf(country).length, country).toBeGreaterThan(0);
    }
  });

  test("search.court-filter-selects-exactly-its-court: every alias and code of every court filters that court alone", () => {
    for (const { country, court, aliases } of ALL_COURTS) {
      const catalog = catalogOf(country);
      for (const form of citedFormsOf({ country, court, aliases })) {
        const reading = readCourtFilter({ court: form, catalog });
        expect(reading, `${country} ${form}`).toMatchObject({
          type: "court",
          courts: [court.name],
        });
      }
    }
  });

  test("a branch and its main court never filter each other", () => {
    expect(BRANCHES.length).toBeGreaterThan(0);
    for (const branch of BRANCHES) {
      const main = mainCourtOf(branch.country, branch.court);
      const catalog = catalogOf(branch.country);
      for (const form of citedFormsOf(branch)) {
        const reading = readCourtFilter({ court: form, catalog });
        expect(
          reading.type === "court" && reading.courts.includes(main.court.name),
          form,
        ).toBe(false);
      }
      for (const form of citedFormsOf(main)) {
        const reading = readCourtFilter({ court: form, catalog });
        expect(
          reading.type === "court" &&
            reading.courts.includes(branch.court.name),
          form,
        ).toBe(false);
      }
    }
  });

  test("search.court-filter-never-widens: a court no decision is stored under is dropped, never read as another court", () => {
    for (const country of IDENTITY_COUNTRIES) {
      const courts = directoryCourtsOf(country);
      for (const absent of courts) {
        const catalog = storedCourtCatalog(
          country,
          courts
            .filter(({ court }) => court.name !== absent.court.name)
            .map(({ court }) => court.name),
        );
        for (const form of citedFormsOf(absent)) {
          const reading = readCourtFilter({ court: form, catalog });
          expect(reading, `${country} ${form}`).toMatchObject({
            type: "dropped",
            warning: {
              code: "filter_dropped",
              message: expect.stringContaining(absent.court.name),
            },
          });
        }
      }
    }
  });

  test("search.court-filter-ambiguous-alias-names-every-court", () => {
    assertProperty(
      "search.court-filter-ambiguous-alias-names-every-court",
      fc.property(
        fc.constantFrom(...ALL_COURTS),
        ({ country, court, aliases }) => {
          const base = catalogOf(country);
          const key = `${country}:${court.name}`;
          const twin = `${key} (twin)`;
          const twinName = `${court.name} (twin)`;
          const catalog: StoredCourtCatalog = {
            index: {
              ...base.index,
              byAlias: new Map(
                [...base.index.byAlias].map(([alias, keys]) => [
                  alias,
                  keys.has(key) ? new Set([...keys, twin]) : keys,
                ]),
              ),
            },
            identities: new Map([
              ...base.identities,
              [twin, { key: twin, name: twinName, spellings: [twinName] }],
            ]),
          };
          for (const alias of aliases) {
            const reading = readCourtFilter({ court: alias, catalog });
            expect(reading, alias).toMatchObject({
              type: "dropped",
              warning: { code: "filter_dropped" },
            });
            if (reading.type === "dropped") {
              expect(reading.warning.hint).toContain(`"${court.name}"`);
              expect(reading.warning.hint).toContain(`"${twinName}"`);
            }
          }
        },
      ),
    );
  });

  test("every stored spelling of a court is one court, filtered together", () => {
    for (const country of IDENTITY_COUNTRIES) {
      const stored = [
        ...directoryCourtsOf(country).map(({ court }) => court.name),
        ...(PUBLISHER_SPELLINGS[country] ?? []),
      ];
      const catalog = storedCourtCatalog(country, stored);
      const filtered = new Map<string, readonly string[]>();
      for (const spelling of stored) {
        const reading = readCourtFilter({ court: spelling, catalog });
        expect(reading.type, `${country} ${spelling}`).toBe("court");
        if (reading.type === "court") {
          expect(reading.courts, spelling).toContain(spelling);
          for (const other of reading.courts) {
            filtered.set(other, reading.courts);
          }
        }
      }
      // A spelling's court is the same set of spellings from each of them.
      for (const spelling of stored) {
        const reading = readCourtFilter({ court: spelling, catalog });
        if (reading.type === "court") {
          expect(filtered.get(spelling), spelling).toEqual(reading.courts);
        }
      }
    }
  });

  test("a publisher's branch spelling filters the branch, and the main court's filters only the main court", () => {
    const catalog = storedCourtCatalog("CZE", [
      "Krajský soud v Brně",
      "Krajský soud v Brně, pobočka Jihlava",
      "Krajský soud v Brně – pobočka ve Zlíně",
    ]);

    expect(
      readCourtFilter({ court: "KS v Brně pobočka v Jihlavě", catalog }),
    ).toMatchObject({
      type: "court",
      courts: ["Krajský soud v Brně, pobočka Jihlava"],
    });
    expect(
      readCourtFilter({ court: "Krajský soud v Brně", catalog }),
    ).toMatchObject({ type: "court", courts: ["Krajský soud v Brně"] });
    // `KSBR` is the code the Jihlava branch publishes under, recorded as the
    // main court's, so it filters the main court.
    expect(readCourtFilter({ court: "KSBR", catalog })).toMatchObject({
      type: "court",
      courts: ["Krajský soud v Brně"],
    });
  });

  test("a branch the corpus holds no decision under is dropped, not read as its main court", () => {
    const catalog = storedCourtCatalog("CZE", ["Krajský soud v Plzni"]);
    const reading = readCourtFilter({
      court: "Krajský soud v Plzni – pobočka v Karlových Varech",
      catalog,
    });

    expect(reading).toMatchObject({
      type: "dropped",
      warning: {
        code: "filter_dropped",
        message: expect.stringContaining(
          "Krajský soud v Plzni – pobočka v Karlových Varech",
        ),
        hint: expect.stringContaining('"Krajský soud v Plzni"'),
      },
    });
  });

  test.each([
    "Krajský soud v Plzni pobočka v Chebu",
    "Krajský soud v Plzni, pobočka",
    "Krajský soud",
    "Okresní soud v Neznámově",
    "OSXY99",
    "Česká republika",
  ])(
    "%p names no court, so it is dropped with the stored courts named",
    (court) => {
      const reading = readCourtFilter({ court, catalog: catalogOf("CZE") });

      expect(reading).toMatchObject({
        type: "dropped",
        warning: { code: "filter_dropped" },
      });
    },
  );

  test("an unrecognized value's hint leads with the stored courts sharing its words", () => {
    const reading = readCourtFilter({
      court: "Krajský soud",
      catalog: storedCourtCatalog("CZE", [
        "Nejvyšší soud",
        "Ústavní soud",
        "Krajský soud v Brně",
      ]),
    });

    expect(reading.type).toBe("dropped");
    if (reading.type === "dropped") {
      expect(reading.warning.hint).toContain('include "Krajský soud v Brně", ');
    }
  });

  test("a documented abbreviation reads every stored spelling without a warning", () => {
    const catalog = storedCourtCatalog("SVK", [
      "Najvyšší súd",
      "Najvyšší súd Slovenskej republiky",
      "Ústavný súd SR",
    ]);

    expect(readCourtFilter({ court: "NS", catalog })).toEqual({
      type: "court",
      courts: ["Najvyšší súd", "Najvyšší súd Slovenskej republiky"],
      warning: null,
    });
  });

  test("a verbatim spelling of a one-spelling court carries no note", () => {
    const catalog = storedCourtCatalog("CZE", ["Nejvyšší soud"]);

    expect(readCourtFilter({ court: "Nejvyšší soud", catalog })).toEqual({
      type: "court",
      courts: ["Nejvyšší soud"],
      warning: null,
    });
  });

  test("a court named in running text with a docket reads as that court, branches included", () => {
    const courts = Object.values(CZ_ECLI_COURT_REGISTRY);
    const catalog = storedCourtCatalog(
      "CZE",
      courts.map(({ name }) => name),
    );
    for (const { name, citationAliases = [] } of courts) {
      for (const alias of citationAliases) {
        const reading = readCourtFilter({
          court: `rozsudek ${alias} 65 A 3/2025`,
          catalog,
        });
        expect(reading, alias).toMatchObject({ type: "court", courts: [name] });
      }
    }
  });

  test("a stored spelling only an alias two courts share could place filters by that exact spelling", () => {
    // Two stored courts outside the directory whose generated short forms
    // coincide, plus a third stored spelling that is that shared form.
    const catalog = storedCourtCatalog("CZE", [
      "Okresní soud Neznámov",
      "Obvodní soud Neznámov",
      "OS Neznámov",
    ]);

    expect(readCourtFilter({ court: "OS Neznámov", catalog })).toMatchObject({
      type: "court",
      courts: ["OS Neznámov"],
    });
  });

  test("a dropped filter's hint never lists an empty set of stored courts", () => {
    const reading = readCourtFilter({
      court: "Krajský soud",
      catalog: storedCourtCatalog("CZE", []),
    });

    expect(reading.type).toBe("dropped");
    if (reading.type === "dropped") {
      expect(reading.warning.hint).not.toContain("include .");
      expect(reading.warning.hint).toContain("omit court");
    }
  });

  test("a stored name outside the directory reads by its own spelling and folded forms", () => {
    const catalog = storedCourtCatalog("POL", [
      "Krajowa Izba Odwoławcza",
      "Sąd Najwyższy",
    ]);
    for (const court of [
      "Krajowa Izba Odwoławcza",
      "krajowa izba odwolawcza",
    ]) {
      expect(foldCourtText(court)).toEqual(
        foldCourtText("Krajowa Izba Odwoławcza"),
      );
      expect(readCourtFilter({ court, catalog })).toMatchObject({
        type: "court",
        courts: ["Krajowa Izba Odwoławcza"],
      });
    }
  });
});

describe("court and courts combine as the search ANDs them", () => {
  const SUPREME = [
    "Najvyšší súd",
    "Najvyšší súd Slovenskej republiky",
  ] as const;

  test("a one-spelling court stays the court filter", () => {
    expect(
      combineCourtFilters({ court: ["Ústavný súd"], courts: undefined }),
    ).toEqual({
      court: "Ústavný súd",
      courts: undefined,
      courtSpellings: ["Ústavný súd"],
    });
  });

  test("a several-spelling court moves into courts", () => {
    expect(combineCourtFilters({ court: SUPREME, courts: undefined })).toEqual({
      court: undefined,
      courts: [...SUPREME],
      courtSpellings: SUPREME,
    });
  });

  test("a several-spelling court intersects a court list", () => {
    expect(
      combineCourtFilters({
        court: SUPREME,
        courts: ["Najvyšší súd", "Ústavný súd"],
      }),
    ).toEqual({
      court: undefined,
      courts: ["Najvyšší súd"],
      courtSpellings: ["Najvyšší súd"],
    });
  });

  test("a contradiction is sent as written", () => {
    expect(
      combineCourtFilters({ court: SUPREME, courts: ["Ústavný súd"] }),
    ).toEqual({
      court: "Najvyšší súd",
      courts: ["Ústavný súd"],
      courtSpellings: ["Najvyšší súd"],
    });
  });

  test("a list that read as nothing is no list", () => {
    expect(combineCourtFilters({ court: undefined, courts: [] })).toEqual({
      court: undefined,
      courts: undefined,
      courtSpellings: undefined,
    });
  });
});
