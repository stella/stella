import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { stripDiacritics } from "@stll/text-normalize";

import {
  hungarianDesignationCollection,
  hungarianDesignationWorkEli,
  type HungarianProvision,
  isMagyarKozlonyCollection,
  isMagyarKozlonyWorkEli,
  MAGYAR_KOZLONY_NUMBERED_WORK_PATTERN,
  magyarKozlonyWorkEli,
  magyarKozlonyWorkPattern,
  magyarKozlonyYearPattern,
  parseRomanNumeral,
  readHungarianActCitations,
  readHungarianLawParts,
  readHungarianProvision,
  romanNumeral,
} from "./magyar-kozlony-designation";

const workOf = (citation: string, citedOn = "2026-11-19") => {
  const acts = readHungarianActCitations(citation, citedOn);
  return acts.length === 1 && acts[0] !== undefined
    ? hungarianDesignationWorkEli(acts[0])
    : `${String(acts.length)} acts`;
};

describe("Magyar Közlöny Work identifiers", () => {
  // The identifiers the gazette ingestion mints for these two designations,
  // as its own fixtures record them.
  test.each([
    [
      "2026. évi LXVIII. törvény",
      "urn:hu:magyar-kozlony:2026-evi-lxviii-torveny",
    ],
    [
      "493/2026. (XI. 18.) Korm. rendelet",
      "urn:hu:magyar-kozlony:493-2026-xi-18-korm-rendelet",
    ],
  ])("%s is the Work the gazette ingestion stores", (designation, eli) => {
    expect(magyarKozlonyWorkEli(designation)).toBe(eli);
    expect(workOf(designation)).toBe(eli);
    expect(isMagyarKozlonyWorkEli(eli)).toBe(true);
  });

  test.each([
    "urn:hu:magyar-kozlony:",
    "urn:hu:magyar-kozlony:2013-evi-V-torveny",
    "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
  ])("%s is not a Magyar Közlöny Work", (eli) => {
    expect(isMagyarKozlonyWorkEli(eli)).toBe(false);
  });
});

describe("Roman numerals", () => {
  test("every number round-trips through its canonical numeral", () => {
    for (let value = 1; value <= 3999; value += 1) {
      const numeral = romanNumeral(value);
      expect(numeral === null ? null : parseRomanNumeral(numeral)).toBe(value);
    }
  });

  test.each(["IIII", "VX", "IC", "", "XIV1"])(
    "%s is not a canonical numeral",
    (text) => {
      expect(parseRomanNumeral(text)).toBeNull();
    },
  );
});

describe("Hungarian act citations", () => {
  test.each([
    [
      "a 2013. évi V. törvény 6:519. §-a",
      "urn:hu:magyar-kozlony:2013-evi-v-torveny",
    ],
    ["2013. évi V. törvénnyel", "urn:hu:magyar-kozlony:2013-evi-v-torveny"],
    ["2013. evi V. tv.", "urn:hu:magyar-kozlony:2013-evi-v-torveny"],
    ["2012.évi C.törvény", "urn:hu:magyar-kozlony:2012-evi-c-torveny"],
    [
      "123/2020. (IV. 30.) Korm. rendeletben",
      "urn:hu:magyar-kozlony:123-2020-iv-30-korm-rendelet",
    ],
    [
      "5/2019. (III.13.) IM rendelet 1. melléklete",
      "urn:hu:magyar-kozlony:5-2019-iii-13-im-rendelet",
    ],
    [
      "3/2015. (II. 2.) AB határozat",
      "urn:hu:magyar-kozlony:3-2015-ii-2-ab-hatarozat",
    ],
  ])("%s names %s", (citation, eli) => {
    expect(workOf(citation)).toBe(eli);
  });

  test("a decree cited without the day it was signed names no Work", () => {
    const acts = readHungarianActCitations(
      "123/2020. Korm. rendelet",
      "2026-01-01",
    );
    expect(acts).toEqual([
      {
        kind: "numbered",
        number: 123,
        year: 2020,
        signed: null,
        issuer: "Korm.",
        form: "rendelet",
      },
    ]);
    expect(
      acts[0] === undefined ? "" : hungarianDesignationWorkEli(acts[0]),
    ).toBeNull();
  });

  test("a recodified code's abbreviation names the code in force on the citing date", () => {
    expect(workOf("Ptk. 6:519. §", "2014-03-15")).toBe(
      "urn:hu:magyar-kozlony:2013-evi-v-torveny",
    );
    expect(workOf("Ptk. 339. §", "2014-03-14")).toBe(
      "urn:hu:magyar-kozlony:1959-evi-iv-torveny",
    );
    expect(workOf("a Btk. 370. §-a", "2026-01-01")).toBe(
      "urn:hu:magyar-kozlony:2012-evi-c-torveny",
    );
  });

  test("an abbreviation and the designation of the same law are one act", () => {
    expect(workOf("Ptk. (2013. évi V. törvény) 6:519. §")).toBe(
      "urn:hu:magyar-kozlony:2013-evi-v-torveny",
    );
  });

  test.each([
    ["two different laws", "2013. évi V. törvény és 2012. évi I. törvény", 2],
    ["a lower-case word", "be. 5. §", 0],
    ["an abbreviation inside a word", "Ptk.Mt", 0],
    ["a non-canonical numeral", "2013. évi IIII. törvény", 0],
    ["a month that does not exist", "1/2020. (XIII. 1.) Korm. rendelet", 0],
    ["a docket number", "Pfv.20503/2025/6", 0],
  ])("%s", (_, citation, count) => {
    expect(readHungarianActCitations(citation, "2026-01-01")).toHaveLength(
      count,
    );
  });

  test("names a law by its parts in Arabic or Roman numerals", () => {
    for (const number of ["130", "CXXX", "cxxx."]) {
      expect(
        readHungarianLawParts({ kind: "törvény", year: "2016", number }),
      ).toEqual({ kind: "law", year: 2016, number: 130 });
    }
    expect(
      readHungarianLawParts({
        kind: "Korm. rendelet",
        year: "2020",
        number: "123",
      }),
    ).toBeNull();
    expect(
      readHungarianLawParts({ kind: "tv.", year: "20", number: "1" }),
    ).toBeNull();
  });

  const ISSUERS = ["Korm.", "IM", "BM", "NGM", "EMMI", "MNB", "AB", "OGY"];
  const FORMS = ["rendelet", "határozat"];

  test("any spelling of a printed designation names the Work it prints", () => {
    const law = fc.record({
      kind: fc.constant("law" as const),
      year: fc.integer({ min: 1990, max: 2030 }),
      number: fc.integer({ min: 1, max: 260 }),
    });
    const numbered = fc.record({
      kind: fc.constant("numbered" as const),
      year: fc.integer({ min: 1990, max: 2030 }),
      number: fc.integer({ min: 1, max: 1200 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 31 }),
      issuer: fc.constantFrom(...ISSUERS),
      form: fc.constantFrom(...FORMS),
    });
    assertProperty(
      "any spelling of a printed designation names the Work it prints",
      fc.property(
        fc.oneof(law, numbered),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("", "ben", "nek", "-a"),
        fc.constantFrom("", "a ", "lásd: "),
        (act, tight, folded, suffix, lead) => {
          const space = tight ? "" : " ";
          const printed =
            act.kind === "law"
              ? `${String(act.year)}. évi ${romanNumeral(act.number) ?? ""}. törvény`
              : `${String(act.number)}/${String(act.year)}. (${romanNumeral(act.month) ?? ""}. ${String(act.day)}.) ${act.issuer} ${act.form}`;
          const variant =
            act.kind === "law"
              ? `${String(act.year)}.${space}évi ${romanNumeral(act.number) ?? ""}.${space}törvény${suffix}`
              : `${String(act.number)}/${String(act.year)}.${space}(${romanNumeral(act.month) ?? ""}.${space}${String(act.day)}.)${space === "" ? " " : space}${act.issuer} ${act.form}${suffix}`;
          const written = folded ? stripDiacritics(variant) : variant;
          expect(workOf(`${lead}${written}`)).toBe(
            magyarKozlonyWorkEli(printed),
          );
        },
      ),
    );
  });
});

describe("Hungarian provision numbers", () => {
  test.each([
    ["6:519. §", [{ unit: "section", designator: "6:519" }]],
    ["§ 6:519", [{ unit: "section", designator: "6:519" }]],
    ["25/G. §-a", [{ unit: "section", designator: "25/G" }]],
    ["25/g", [{ unit: "section", designator: "25/G" }]],
    ["IV. cikk", [{ unit: "article", designator: "IV" }]],
    ["1. cikke", [{ unit: "article", designator: "1" }]],
    ["XV.", [{ unit: "article", designator: "XV" }]],
    [
      "10",
      [
        { unit: "section", designator: "10" },
        { unit: "article", designator: "10" },
      ],
    ],
    ["10. § (2) bekezdés", []],
    ["IIII", []],
  ] satisfies [string, HungarianProvision[]][])("%s", (written, expected) => {
    expect(readHungarianProvision(written)).toEqual(expected);
  });
});

describe("Magyar Közlöny Work patterns", () => {
  const designation = fc.oneof(
    fc.record({
      kind: fc.constant("law" as const),
      year: fc.integer({ min: 1990, max: 2030 }),
      number: fc.integer({ min: 1, max: 260 }),
    }),
    fc.record({
      kind: fc.constant("numbered" as const),
      year: fc.integer({ min: 1990, max: 2030 }),
      number: fc.integer({ min: 1, max: 1200 }),
      signed: fc.record({
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 31 }),
      }),
      issuer: fc.constantFrom("Korm.", "IM", "NGM", "MNB", "AB"),
      form: fc.constantFrom("rendelet" as const, "hatarozat" as const),
    }),
  );

  test("an act's number, year and series match its Work and no neighbour's", () => {
    assertProperty(
      "an act's number, year and series match its Work and no neighbour's",
      fc.property(designation, fc.integer({ min: 1, max: 9 }), (act, shift) => {
        const eli = hungarianDesignationWorkEli(act) ?? "";
        const collection = hungarianDesignationCollection(act);
        expect(isMagyarKozlonyCollection(collection)).toBe(true);
        for (const series of [collection, undefined]) {
          const own = magyarKozlonyWorkPattern({ ...act, collection: series });
          expect(new RegExp(own ?? "^$", "u").test(eli)).toBe(true);
          const neighbour = magyarKozlonyWorkPattern({
            ...act,
            number: act.number + shift,
            collection: series,
          });
          expect(new RegExp(neighbour ?? "^$", "u").test(eli)).toBe(false);
        }
        expect(
          new RegExp(magyarKozlonyYearPattern(act.year), "u").test(eli),
        ).toBe(true);
        expect(
          new RegExp(magyarKozlonyYearPattern(act.year + shift), "u").test(eli),
        ).toBe(false);
        const numbered = new RegExp(
          MAGYAR_KOZLONY_NUMBERED_WORK_PATTERN,
          "u",
        ).exec(eli);
        expect(numbered?.[1]).toBe(
          act.kind === "numbered" ? String(act.number) : undefined,
        );
      }),
    );
  });
});
