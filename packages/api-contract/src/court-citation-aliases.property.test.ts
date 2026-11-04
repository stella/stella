import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { ECLI_COURT_REGISTRY, type RegisteredCourt } from "./case-law-courts";
import {
  courtCitationIndex,
  directoryCourtAliases,
  foldCourtText,
  readCourtCitation,
  storedCourtKeys,
} from "./court-citation-aliases";
import {
  COURT_DIRECTORY,
  ECLI_JURISDICTION_OF_COUNTRY,
} from "./court-citation-directory";

const DIRECTORY_COUNTRIES = Object.keys(COURT_DIRECTORY).filter(
  (country): country is keyof typeof COURT_DIRECTORY =>
    Object.hasOwn(COURT_DIRECTORY, country),
);

const directoryCourts = DIRECTORY_COUNTRIES.flatMap((country) =>
  COURT_DIRECTORY[country].map((court) => ({
    country,
    court,
    key: `${country}:${court.name}`,
    aliases: directoryCourtAliases(country, court),
  })),
);

const readsAs = (country: string, text: string) =>
  readCourtCitation(courtCitationIndex(country), text);

describe("court citation aliases", () => {
  test("no alias of the directory answers to two courts", () => {
    for (const country of DIRECTORY_COUNTRIES) {
      const ambiguous = [...courtCitationIndex(country).byAlias]
        .filter(([, keys]) => keys.size > 1)
        .map(([alias, keys]) => `${alias} → ${[...keys].join(" | ")}`);
      expect(ambiguous, country).toEqual([]);
    }
  });

  test("every directory court reads from each of its generated aliases and codes", () => {
    expect(directoryCourts.length).toBeGreaterThan(150);
    for (const { country, court, key, aliases } of directoryCourts) {
      expect(aliases.length, court.name).toBeGreaterThan(1);
      for (const alias of aliases) {
        expect(readsAs(country, alias), `${country} ${alias}`).toEqual([
          { type: "court", courts: [key] },
        ]);
      }
      for (const code of court.ecliCodes.filter(({ length }) => length > 1)) {
        expect(readsAs(country, code), `${country} ${code}`).toEqual([
          { type: "court", courts: [key] },
        ]);
      }
    }
  });

  test("every directory court is the court its stored name and recorded ECLI code place", () => {
    for (const { country, court, key } of directoryCourts) {
      const index = courtCitationIndex(country);
      expect(storedCourtKeys(index, { court: court.name, ecli: null })).toEqual(
        [key],
      );
      for (const code of court.ecliCodes) {
        const ecli = `ECLI:${ECLI_JURISDICTION_OF_COUNTRY[country]}:${code}:2020:1`;
        expect(
          storedCourtKeys(index, { court: court.name, ecli }),
          ecli,
        ).toEqual([key]);
      }
    }
  });

  test("every ECLI registry court is a directory court under the same code", () => {
    const registries = [
      ["CZE", ECLI_COURT_REGISTRY.CZ],
      ["SVK", ECLI_COURT_REGISTRY.SK],
      ["EU", ECLI_COURT_REGISTRY.EU],
    ] as const;
    for (const [country, courts] of registries) {
      const registry = Object.entries<RegisteredCourt>(courts);
      for (const [code, { name }] of registry) {
        const listed = COURT_DIRECTORY[country].find(
          (court) => court.name === name,
        );
        expect(listed?.ecliCodes, `${country} ${code}`).toContain(code);
      }
    }
  });

  test.each([
    "Obvodní soud pro Prahu 6",
    "Obvodního soudu pro Prahu 6",
    "obvodni soud pro prahu 6",
    "OS Praha 6",
    "OS P6",
    "OS P 6",
    "OS pro Prahu 6",
    "OS v Praze 6",
    "Obvodní soud Praha 6",
    "Obvodní soud v Praze 6",
    "ObvS Praha 6",
    "OSPH06",
    "osph06",
  ])("a Prague district court reads from %s", (text) => {
    expect(readsAs("CZE", text)).toEqual([
      { type: "court", courts: ["CZE:Obvodní soud pro Prahu 6"] },
    ]);
  });

  test.each([
    [
      "Krajský soud v Ústí nad Labem, pobočka Liberec",
      "Krajský soud v Ústí nad Labem – pobočka v Liberci",
    ],
    [
      "Krajský soud v Hradci Králové, pobočka Pardubice",
      "Krajský soud v Hradci Králové – pobočka v Pardubicích",
    ],
    [
      "Krajský soud v Ostravě, pobočka Olomouc",
      "Krajský soud v Ostravě – pobočka v Olomouci",
    ],
    [
      "Krajský soud v Českých Budějovicích, pobočka v Táboře",
      "Krajský soud v Českých Budějovicích – pobočka v Táboře",
    ],
    [
      "Krajský soud v Brně, pobočka Jihlava",
      "Krajský soud v Brně – pobočka v Jihlavě",
    ],
    ["KS Olomouc", "Krajský soud v Ostravě – pobočka v Olomouci"],
    ["NS ČR", "Nejvyšší soud"],
    [
      "Supreme Administrative Court of the Czech Republic",
      "Nejvyšší správní soud",
    ],
    ["Okresní soud Plzeň-město", "Okresní soud Plzeň-město"],
    ["OS Plzeň město", "Okresní soud Plzeň-město"],
    ["MS Brno", "Městský soud v Brně"],
  ])("a publisher's or citation's spelling %s reads as %s", (text, name) => {
    expect(readsAs("CZE", text)).toEqual([
      { type: "court", courts: [`CZE:${name}`] },
    ]);
  });

  test.each([
    ["Najvyšší súd SR", "Najvyšší súd Slovenskej republiky"],
    ["NS SR", "Najvyšší súd Slovenskej republiky"],
    ["Krajského súdu v Bratislave", "Krajský súd v Bratislave"],
    ["KS BA", "Krajský súd v Bratislave"],
    ["KS Košice", "Krajský súd v Košiciach"],
    ["Okresného súdu Bratislava I", "Okresný súd Bratislava I"],
    ["OS Bratislava I", "Okresný súd Bratislava I"],
    ["Správneho súdu v Banskej Bystrici", "Správny súd v Banskej Bystrici"],
    ["NSS SR", "Najvyšší správny súd Slovenskej republiky"],
  ])("a Slovak spelling %s reads as %s", (text, name) => {
    expect(readsAs("SVK", text)).toEqual([
      { type: "court", courts: [`SVK:${name}`] },
    ]);
  });

  test.each([
    "soudní rozhodnutí",
    "rozhodnutí soudu",
    "súdne rozhodnutie",
    "rozsudek",
    "ze dne 3. 4. 2024",
    "",
  ])("words that name no particular court constrain nothing: %s", (text) => {
    expect(readsAs("CZE", text)).toEqual([]);
  });

  test.each([
    "soud v Neznámově",
    "súdu vo Zvolene",
    "Okresní soud v Neznámově",
    "Krajský soud",
    "OS Neznámov",
  ])(
    "words that name a court no alias reads are an unreadable court: %s",
    (text) => {
      expect(readsAs("CZE", text)).toEqual([{ type: "unrecognized" }]);
    },
  );

  test("a code-shaped word the directory lacks constrains by ECLI code", () => {
    expect(readsAs("CZE", "OSXY")).toEqual([
      { type: "ecli-code", code: "OSXY" },
    ]);
  });

  test("an alias two stored courts answer to is read as both, never one", () => {
    const index = courtCitationIndex("CZE", [
      "Okresní soud Neznámov",
      "Obvodní soud Neznámov",
    ]);
    expect(readCourtCitation(index, "OS Neznámov")).toEqual([
      {
        type: "court",
        courts: [
          "CZE:stored:obvodni soud neznamov",
          "CZE:stored:okresni soud neznamov",
        ],
      },
    ]);
  });

  test("court-citation.alias-spelling-variants", () => {
    const withAliases = directoryCourts.flatMap(({ country, key, aliases }) =>
      aliases.map((alias) => ({ country, key, alias })),
    );
    assertProperty(
      "court-citation.alias-spelling-variants",
      fc.property(
        fc.constantFrom(...withAliases),
        fc.constantFrom("upper", "lower", "ascii", "as-is"),
        fc.constantFrom(" ", "  ", " "),
        fc.constantFrom("", ",", " –", "."),
        ({ country, key, alias }, casing, space, trailing) => {
          const cased = {
            upper: alias.toLocaleUpperCase("und"),
            lower: alias.toLocaleLowerCase("und"),
            ascii: foldCourtText(alias).join(" "),
            "as-is": alias,
          }[casing];
          const spelled = `${cased.split(" ").join(space)}${trailing}`;
          const reading = readsAs(country, spelled);
          // Upper case turns a short code's letters into a code word only
          // where the directory records it for the same court.
          expect(reading).toEqual([{ type: "court", courts: [key] }]);
        },
      ),
    );
  });
});
