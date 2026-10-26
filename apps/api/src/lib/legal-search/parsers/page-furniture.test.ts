import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  continuesAcrossPageBreak,
  isPageNumberLine,
  isRunningHeaderLine,
  withoutSoftHyphens,
} from "./page-furniture";

describe("running headers", () => {
  test.each([
    // Verbatim from NSS, a regional court on the NSS portal, a district
    // court on rozhodnuti.justice.cz and Nejvyšší soud print pages.
    "pokračování 2 1 As 23/2012-45",
    "pokračování -2- 52A 35/2012",
    "pokračování - 2 - sp. zn. 9 C 191/2025",
    "pokračování -3- sp. zn. 9 C 191/2025",
    "Pokračování\t\t\t\t\t3\t\t\t       22 Cdo 1717/2000-228",
    "Pokračování\t3\t22 Cdo 4223/2018 22 Cdo 4223/2018-137",
    "pokračování 3 Konf 4/2011",
  ])("reads %j as a running header", (line) => {
    expect(isRunningHeaderLine(line)).toBe(true);
  });

  test("running header spellings", () => {
    assertProperty(
      "running header spellings",
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.constantFrom("", "-", " - "),
        fc.option(fc.integer({ min: 1, max: 99 }), { nil: undefined }),
        fc.constantFrom("As", "Afs", "A", "Ca", "C", "Co", "Cdo", "Tdo", "T"),
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1990, max: 2030 }),
        fc.constantFrom("", "sp. zn. ", "č. j. "),
        (page, dash, panel, register, number, year, prefix) => {
          const docket = `${prefix}${panel === undefined ? "" : `${String(panel)} `}${register} ${String(number)}/${String(year)}`;
          expect(
            isRunningHeaderLine(
              `pokračování ${dash}${String(page)}${dash} ${docket}`,
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test.each([
    "Pokračování řízení bylo nařízeno.",
    "pokračování 2 dny poté, co soud rozhodl",
    "pokračování -2- 52A 35/2012 a dále soud uvedl",
    // A different docket after the header's opens the page's text.
    "pokračování 2 1 As 23/2012-45 2 Afs 1/2010-50",
  ])("leaves %j in the text", (line) => {
    expect(isRunningHeaderLine(line)).toBe(false);
  });
});

describe("page numbers", () => {
  test.each(["2", "- 2 -", "-12-", " 4 "])("reads %j as one", (line) => {
    expect(isPageNumberLine(line)).toBe(true);
  });

  test.each(["2.", "1)", "2004", "I.", "2 Afs"])("leaves %j", (line) => {
    expect(isPageNumberLine(line)).toBe(false);
  });
});

describe("sentences a page break cut", () => {
  const cut =
    "Stěžovatel namítá, že citovaná správní rozhodnutí musí podléhat soudnímu přezkumu. Navíc je bezdůvodné přednostně aplikovat zákon";

  test.each([
    "č. 337/1992 Sb., o správě daní a poplatků.",
    "§ 6 odst. 1 vyhlášky č. 177/1996 Sb.",
    "2004, sp. zn. 31 Ca 51/2004.",
  ])("go on with %j", (next) => {
    expect(continuesAcrossPageBreak(cut, next)).toBe(true);
  });

  test.each([
    // A capital, a list item or the court's numbered paragraph opens text.
    "Krajský soud žalobu zamítl.",
    "a) náhradu škody,",
    "2. žalobce doložil plnou moc,",
    "12. Žaloba je nedůvodná.",
    "[12] Žaloba je nedůvodná.",
  ])("do not go on with %j", (next) => {
    expect(continuesAcrossPageBreak(cut, next)).toBe(false);
  });

  test("end where the sentence did", () => {
    expect(continuesAcrossPageBreak(`${cut} č. 337/1992 Sb.`, "a dále")).toBe(
      false,
    );
    expect(continuesAcrossPageBreak(`${cut} (viz výše).`, "a dále")).toBe(
      false,
    );
  });

  test("never join a name to the title under it", () => {
    expect(continuesAcrossPageBreak("Josef Baxa", "předseda senátu")).toBe(
      false,
    );
  });
});

test("soft hyphens leave the text", () => {
  expect(withoutSoftHyphens("rozhod­nutí fi­nanční")).toBe(
    "rozhodnutí finanční",
  );
});
