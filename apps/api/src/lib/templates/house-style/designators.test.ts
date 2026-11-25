import { describe, expect, test } from "bun:test";

import {
  countedOrdinal,
  formatNumeral,
  labelFieldText,
  letterOrdinal,
  parseLabelShape,
} from "@/api/lib/templates/house-style/designators";

describe("parseLabelShape", () => {
  test.each([
    ["1.", null, "decimal", "1", "1"],
    ["12.", null, "decimal", "12", "12"],
    ["5.1.", null, "decimal", "5.1", "5.1"],
    ["5.1.2", null, "decimal", "5.1.2", "5.1.2"],
    ["(3)", null, "decimal", "3", "(3)"],
    ["a)", null, "lowerLetter", "a", "a)"],
    ["(b)", null, "lowerLetter", "b", "(b)"],
    ["aa)", null, "lowerLetter", "aa", "aa)"],
    ["aaa)", null, "lowerLetter", "aaa", "aaa)"],
    ["AA)", null, "upperLetter", "AA", "AA)"],
    ["(ii)", null, "lowerRoman", "ii", "(ii)"],
    ["xiv.", null, "lowerRoman", "xiv", "xiv"],
    ["i)", null, "lowerAmbiguous", "i", "i)"],
    ["(v)", null, "lowerAmbiguous", "v", "(v)"],
    ["A.", null, "upperLetter", "A", "A"],
    ["(B)", null, "upperLetter", "B", "(B)"],
    ["II.", null, "upperRoman", "II", "II"],
    ["V.", null, "upperAmbiguous", "V", "V"],
    ["Článek XI.", "article", "upperRoman", "XI", "XI"],
    ["ČLÁNEK V", "article", "upperRoman", "V", "V"],
    ["Čl. 3", "article", "decimal", "3", "3"],
    ["Čl.\u00A03.", "article", "decimal", "3", "3"],
    ["Article 12", "article", "decimal", "12", "12"],
    ["Art. IV", "article", "upperRoman", "IV", "IV"],
    ["Section 2", "article", "decimal", "2", "2"],
    ["Ziffer 4", "article", "decimal", "4", "4"],
    ["§ 5", "sectionSign", "decimal", "5", "5"],
    ["§5", "sectionSign", "decimal", "5", "5"],
    ["Příloha č. 1", "annex", "decimal", "1", "1"],
    ["PŘÍLOHA Č. 2", "annex", "decimal", "2", "2"],
    ["Annex B", "annex", "upperLetter", "B", "B"],
    ["Schedule 3", "annex", "decimal", "3", "3"],
    ["Anlage 1", "annex", "decimal", "1", "1"],
  ] as const)("%s", (label, keyword, numeral, core, fieldText) => {
    const shape = parseLabelShape(label);
    expect(shape).toMatchObject({ keyword, numeral, core });
    expect(shape?.length).toBe(label.length);
    expect(shape === null ? null : labelFieldText(shape)).toBe(fieldText);
  });

  test.each(["", "-", "•", "(a", "abc)", "Kapitola 1", "smlouva", "IIII."])(
    "rejects %s",
    (label) => {
      expect(parseLabelShape(label)).toBeNull();
    },
  );

  test("reads only the label at the start of a paragraph", () => {
    expect(parseLabelShape("5.1\tDodavatel dodá zboží.")).toMatchObject({
      core: "5.1",
      path: [5, 1],
      length: 3,
    });
    expect(parseLabelShape("Článek V. Cena")).toMatchObject({
      core: "V",
      period: true,
      length: 9,
    });
    expect(parseLabelShape("Vyšší moc")).toBeNull();
    // Six components are more than a label carries; five are not cut out.
    expect(parseLabelShape("1.2.3.4.5.6 Heading")).toBeNull();
    expect(parseLabelShape("AB) text")).toBeNull();
  });
});

describe("numerals", () => {
  test("letters count the way Word counts them", () => {
    expect(["a", "z", "aa", "bb", "ab", "1"].map(letterOrdinal)).toEqual([
      1,
      26,
      27,
      28,
      null,
      null,
    ]);
  });

  test("counted designators", () => {
    expect(["11", "XI", "xi", "IIII", "a"].map(countedOrdinal)).toEqual([
      11,
      11,
      11,
      null,
      null,
    ]);
  });

  test.each([
    [11, "decimal", "11"],
    [11, "upperRoman", "XI"],
    [4, "lowerRoman", "iv"],
    [4, "lowerLetter", "d"],
    [27, "lowerLetter", "aa"],
    [2, "upperLetter", "B"],
    [1, "bullet", null],
    [1, "none", null],
  ] as const)("formats %d as %s", (value, numFmt, expected) => {
    expect(formatNumeral(value, numFmt)).toBe(expected);
  });
});
