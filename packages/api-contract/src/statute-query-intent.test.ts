import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { STATUTE_ALIASES } from "./statute-aliases";
import type { StatuteQueryCountry } from "./statute-query-capability";
import {
  foldStatuteQuery,
  parseStatuteQuery,
  readStatuteQueryReferences,
} from "./statute-query-intent";

const countries = Object.keys(STATUTE_ALIASES).filter(
  (country): country is StatuteQueryCountry =>
    Object.hasOwn(STATUTE_ALIASES, country),
);

const SPACES = [" ", "  ", " ", "　", "\t", ""] as const;

const number = fc.integer({ min: 1, max: 99_999 });
const year = fc.integer({ min: 1918, max: 2026 });
const space = fc.constantFrom(...SPACES);
const prefix = fc.constantFrom(
  "",
  "č. ",
  "zákon ",
  "zákon č. ",
  "z. ",
  "zák. ",
  "vyhláška ",
  "ZÁKON Č. ",
);
const czechSuffix = fc.constantFrom(
  ["", "sb"],
  ["Sb.", "sb"],
  ["Sb", "sb"],
  ["sb.", "sb"],
  ["SB.", "sb"],
);
const slovakSuffix = fc.constantFrom(
  ["", "zz"],
  ["Zb.", "zz"],
  ["Z. z.", "zz"],
  ["Z.z.", "zz"],
  ["z. z", "zz"],
  ["ZB", "zz"],
);

const spelled = (parts: readonly string[], spaces: readonly string[]): string =>
  parts.map((part, index) => `${part}${spaces[index] ?? ""}`).join("");

describe("reading an act number", () => {
  test("every lenient spelling of a Czech number names the same act", () => {
    assertProperty(
      "every lenient spelling of a Czech number names the same act",
      fc.property(
        number,
        year,
        prefix,
        czechSuffix,
        fc.array(space, { minLength: 4, maxLength: 4 }),
        (n, y, pre, [suffix, collection], spaces) => {
          const raw = spelled([pre, String(n), "/", String(y), suffix], spaces);

          expect(parseStatuteQuery("cze", raw)).toEqual({
            type: "act",
            collection,
            label: null,
            number: String(n),
            provision: null,
            year: String(y),
          });
        },
      ),
    );
  });

  test("every lenient spelling of a Slovak number names the same act", () => {
    assertProperty(
      "every lenient spelling of a Slovak number names the same act",
      fc.property(
        number,
        year,
        slovakSuffix,
        fc.array(space, { minLength: 3, maxLength: 3 }),
        (n, y, [suffix, collection], spaces) => {
          const raw = spelled([String(n), "/", String(y), suffix], spaces);

          expect(parseStatuteQuery("svk", raw)).toEqual({
            type: "act",
            collection,
            label: null,
            number: String(n),
            provision: null,
            year: String(y),
          });
        },
      ),
    );
  });

  test("full-width digits and leading zeros read as the same number", () => {
    expect(parseStatuteQuery("cze", "０８９／２０１２")).toMatchObject({
      type: "act",
      number: "89",
      year: "2012",
    });
  });

  test("a provision ahead of the number is kept as a jump target", () => {
    expect(parseStatuteQuery("cze", "§ 2079 zákona č. 89/2012 Sb.")).toEqual({
      type: "act",
      collection: "sb",
      label: null,
      number: "89",
      provision: "§ 2079",
      year: "2012",
    });
    expect(parseStatuteQuery("cze", "§2079 odst. 1 OZ")).toMatchObject({
      type: "act",
      number: "89",
      provision: "§ 2079",
      label: "Občanský zákoník",
    });
    expect(parseStatuteQuery("cze", "čl. 10 ústava")).toMatchObject({
      type: "act",
      number: "1",
      provision: "cl. 10",
    });
  });

  test("text that is not a reference searches titles verbatim", () => {
    expect(parseStatuteQuery("cze", "  občanský zákoník 2012 ")).toEqual({
      type: "text",
      text: "občanský zákoník 2012",
    });
    expect(parseStatuteQuery("cze", "89/12")).toEqual({
      type: "text",
      text: "89/12",
    });
    // A collection the jurisdiction does not publish must not widen the
    // number to every collection: 40/1964 Sb. is a different act.
    expect(parseStatuteQuery("cze", "40/1964 Z. z.")).toEqual({
      type: "text",
      text: "40/1964 Z. z.",
    });
    expect(parseStatuteQuery("svk", "89/2012 Sb.")).toEqual({
      type: "text",
      text: "89/2012 Sb.",
    });
    expect(parseStatuteQuery("cze", "")).toEqual({ type: "empty" });
    expect(parseStatuteQuery("cze", "§ 2079")).toEqual({
      type: "text",
      text: "§ 2079",
    });
  });
});

describe("reading an alias", () => {
  test("every alias of every jurisdiction resolves to its act, however cased", () => {
    for (const country of countries) {
      for (const [alias, target] of Object.entries(STATUTE_ALIASES[country])) {
        // Aliases are stored folded; a stored key that is not its own fold
        // could never be typed.
        expect(foldStatuteQuery(alias)).toBe(alias);
        for (const typed of [alias, alias.toUpperCase(), ` ${alias} `]) {
          expect(parseStatuteQuery(country, typed)).toEqual({
            type: "act",
            collection: target.collection,
            label: target.label,
            number: target.number,
            provision: null,
            year: target.year,
          });
        }
      }
    }
  });

  test("the same alias opens a different act per jurisdiction", () => {
    expect(parseStatuteQuery("cze", "OZ")).toMatchObject({
      number: "89",
      year: "2012",
    });
    expect(parseStatuteQuery("svk", "OZ")).toMatchObject({
      number: "40",
      year: "1964",
    });
  });

  test("diacritics and abbreviation dots are not required", () => {
    expect(parseStatuteQuery("cze", "Občanský zákoník")).toMatchObject({
      number: "89",
      year: "2012",
    });
    expect(parseStatuteQuery("cze", "obc. zak.")).toMatchObject({
      number: "89",
    });
    expect(parseStatuteQuery("cze", "OSŘ")).toMatchObject({ number: "99" });
    expect(parseStatuteQuery("cze", "sřs")).toMatchObject({ number: "150" });
    expect(parseStatuteQuery("svk", "Obchodný zákonník")).toMatchObject({
      number: "513",
    });
  });
});

describe("reading act references inside a full-text query", () => {
  test("embedded citations preserve mention order and their collections", () => {
    expect(
      readStatuteQueryReferences(
        "cze",
        "Výklad §2051 zákona č. 89/2012 Sb., ve spojení s č. 57/2008 Sb. m. s. a 90/2012 Sb.",
      ),
    ).toEqual([
      {
        country: "cze",
        collection: "sb",
        number: "89",
        year: "2012",
        label: null,
      },
      {
        country: "cze",
        collection: "sm",
        number: "57",
        year: "2008",
        label: null,
      },
      {
        country: "cze",
        collection: "sb",
        number: "90",
        year: "2012",
        label: null,
      },
    ]);
  });

  test("the same act number in different collections stays distinct", () => {
    expect(
      readStatuteQueryReferences("cze", "výklad 57/2008 Sb. a 57/2008 Sb.m.s."),
    ).toEqual([
      {
        country: "cze",
        collection: "sb",
        number: "57",
        year: "2008",
        label: null,
      },
      {
        country: "cze",
        collection: "sm",
        number: "57",
        year: "2008",
        label: null,
      },
    ]);
  });

  test("section-adjacent aliases and citations identify acts without confusing section numbers", () => {
    expect(
      readStatuteQueryReferences("cze", "§2051 OZ a §52 písm. f) ZP"),
    ).toEqual([
      { country: "cze", ...STATUTE_ALIASES.cze.oz },
      { country: "cze", ...STATUTE_ALIASES.cze.zp },
    ]);
    expect(
      readStatuteQueryReferences("cze", "§2051, odst. 2 zákona č.89/2012Sb."),
    ).toEqual([
      {
        country: "cze",
        collection: "sb",
        number: "89",
        year: "2012",
        label: null,
      },
    ]);
    expect(
      readStatuteQueryReferences(
        "cze",
        "§2051 odst. 2 písm. f), 1. 1. 2024, 50000 Kč",
      ),
    ).toEqual([]);
  });

  test("ordinary Czech and Slovak prose never supplies alias pins", () => {
    const sentences = [
      "zakladatelská listina stanoví název spolku",
      "občanský průkaz musí mít každý občan",
      "občanský život se týká sousedských vztahů",
      "tr. čin musí být prokázán svědeckou výpovědí",
      "sr je součást označení souboru v seznamu",
      "občan SR podává žádost o vydání průkazu",
      "listina obsahuje podpis občana a datum",
      "občiansky preukaz sa vydáva občanovi",
      "ústava upravuje základné princípy štátu",
      "oz a zp jsou malá písmena v poznámce",
      "trz označuje položku v interním seznamu",
    ];
    assertProperty(
      "ordinary Czech and Slovak prose never supplies alias pins",
      fc.property(
        fc.constantFrom(...countries),
        fc.constantFrom(...sentences),
        fc.array(
          fc.constantFrom("dnes", "prosím", "podrobně", "výklad", "otázka"),
          { maxLength: 20 },
        ),
        (country, sentence, words) => {
          expect(
            readStatuteQueryReferences(
              country,
              `${words.join(" ")} ${sentence} ${words.join(" ")}`,
            ),
          ).toEqual([]);
        },
      ),
    );
  });

  test("abbreviations embedded in long text retain their case", () => {
    for (const abbreviation of ["oz", "zp", "zok", "osř", "trz", "sr"]) {
      expect(
        readStatuteQueryReferences(
          "cze",
          `Rozsáhlý popis smluvních vztahů obsahuje ${abbreviation} v poznámce a další podrobnosti`,
        ),
      ).toEqual([]);
    }
    expect(readStatuteQueryReferences("cze", "výklad CSP ve sporu")).toEqual(
      [],
    );
    expect(readStatuteQueryReferences("svk", "výklad ZOK ve sporu")).toEqual(
      [],
    );
  });

  test("embedded numeric references need an act marker and exclude dockets", () => {
    for (const country of countries) {
      for (const register of [
        "Cdo",
        "Tdo",
        "Nd",
        "Odo",
        "As",
        "Ads",
        "Afs",
        "Azs",
        "Co",
        "To",
        "od",
      ]) {
        for (const suffix of ["", country === "cze" ? " Sb." : " Z. z."]) {
          for (const docketPrefix of [
            register,
            `21 ${register}`,
            `${register} č.`,
          ]) {
            expect(
              readStatuteQueryReferences(
                country,
                `výklad ${docketPrefix} 89/2012${suffix} ve věci`,
              ),
            ).toEqual([]);
          }
        }
      }
      expect(
        readStatuteQueryReferences(country, "ve věci 89/2012 bylo rozhodnuto"),
      ).toEqual([]);
      expect(
        readStatuteQueryReferences(
          country,
          "ve věci zákona č. 89/2012 bylo rozhodnuto",
        ),
      ).toEqual([
        {
          country,
          collection: country === "cze" ? "sb" : "zz",
          number: "89",
          year: "2012",
          label: null,
        },
      ]);
    }
    expect(readStatuteQueryReferences("cze", "89/2012")).toEqual([
      {
        country: "cze",
        collection: "sb",
        number: "89",
        year: "2012",
        label: null,
      },
    ]);
    for (const suffix of ["Ú. l.", "Ú.l. I", "Ú.l. II"]) {
      expect(parseStatuteQuery("cze", `89/2012 ${suffix}`).type).toBe("text");
      expect(
        readStatuteQueryReferences("cze", `výklad 89/2012 ${suffix}`),
      ).toEqual([]);
    }
  });

  test("SR is a whole-query alias rather than a country abbreviation pin", () => {
    for (const typed of ["SR", "sr", "Sr"]) {
      expect(readStatuteQueryReferences("cze", typed)).toEqual([
        { country: "cze", ...STATUTE_ALIASES.cze.sr },
      ]);
      expect(
        readStatuteQueryReferences("cze", `občan ${typed} podává žádost`),
      ).toEqual([]);
    }
    expect(readStatuteQueryReferences("cze", "výklad SŘ pro řízení")).toEqual(
      [],
    );
  });

  test("required Czech abbreviations resolve with and without diacritics", () => {
    for (const [typed, target] of [
      ["OZ", STATUTE_ALIASES.cze.oz],
      ["NOZ", STATUTE_ALIASES.cze.noz],
      ["ZOK", STATUTE_ALIASES.cze.zok],
      ["OSŘ", STATUTE_ALIASES.cze.osr],
      ["OSR", STATUTE_ALIASES.cze.osr],
      ["TrZ", STATUTE_ALIASES.cze.trz],
      ["ZP", STATUTE_ALIASES.cze.zp],
      ["Občanský zákoník", STATUTE_ALIASES.cze.oz],
      ["obcansky zakonik", STATUTE_ALIASES.cze.oz],
    ] as const) {
      expect(
        readStatuteQueryReferences("cze", `výklad ${typed} pro smlouvu`),
      ).toEqual([{ country: "cze", ...target }]);
    }
    const decomposed = "OSŘ".normalize("NFD");
    expect(decomposed).not.toBe("OSŘ");
    expect(
      readStatuteQueryReferences("cze", `výklad ${decomposed} pro řízení`),
    ).toEqual([{ country: "cze", ...STATUTE_ALIASES.cze.osr }]);
  });

  test("repeated aliases and explicit citations produce one reference per identity", () => {
    expect(
      readStatuteQueryReferences("cze", "ZP, OZ, NOZ, 89/2012 Sb., OZ, ZP"),
    ).toEqual([
      { country: "cze", ...STATUTE_ALIASES.cze.zp },
      { country: "cze", ...STATUTE_ALIASES.cze.oz },
    ]);
  });

  test("an alias embedded in another word never pins its act", () => {
    assertProperty(
      "an alias embedded in another word never pins its act",
      fc.property(fc.constantFrom("a", "ž", "7"), (boundary) => {
        for (const country of countries) {
          for (const alias of Object.keys(STATUTE_ALIASES[country])) {
            expect(
              readStatuteQueryReferences(
                country,
                `${boundary}${alias}${boundary}`,
              ),
            ).toEqual([]);
          }
        }
      }),
    );
  });

  test.each(["Sb. NSS", "Sb.NSS", "Sb. rozh.", "Sb.rozh.", "sb. ROZH."])(
    "reporter %s cannot pin a statute with the same act number",
    (reporter) => {
      expect(
        readStatuteQueryReferences(
          "cze",
          `výklad 89/2012 ${reporter} a zákona č. 90/2012 Sb.`,
        ),
      ).toEqual([
        {
          country: "cze",
          collection: "sb",
          number: "90",
          year: "2012",
          label: null,
        },
      ]);
    },
  );

  test("case-law reporters never pin statutes across spacing and case variants", () => {
    assertProperty(
      "case-law reporters never pin statutes across spacing and case variants",
      fc.property(number, year, (n, y) => {
        for (const gap of SPACES) {
          for (const reporter of ["NSS", "nss", "rozh.", "ROZH."]) {
            for (const actPrefix of ["", "č. ", "zákona č. "]) {
              const citation = `${actPrefix}${n}/${y} Sb.${gap}${reporter}`;
              expect(parseStatuteQuery("cze", citation).type).toBe("text");
              expect(
                readStatuteQueryReferences("cze", `výklad ${citation}`),
              ).toEqual([]);
            }
          }
        }
      }),
    );
  });

  test("foreign gazettes and fragments of larger identifiers do not pin an act", () => {
    expect(
      readStatuteQueryReferences(
        "cze",
        "40/1964 Z. z. a 89/2012 Sb. NSS a 90/2012 Sb. rozh.",
      ),
    ).toEqual([]);
    expect(
      readStatuteQueryReferences("svk", "89/2012 Sb. a 57/2008 Sb. m. s."),
    ).toEqual([]);
    for (const fragment of [
      "x89/2012",
      "89/2012x",
      "123456/2012",
      "89/20120",
      "1/89/2012",
      "89/2012/3",
    ]) {
      expect(readStatuteQueryReferences("cze", `výklad ${fragment}`)).toEqual(
        [],
      );
    }
    expect(
      readStatuteQueryReferences("svk", "výklad zákona č. 40/1964 Zb."),
    ).toEqual([
      {
        country: "svk",
        collection: "zz",
        number: "40",
        year: "1964",
        label: null,
      },
    ]);
  });
});
