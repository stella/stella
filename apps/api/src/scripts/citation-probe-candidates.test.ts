import { describe, expect, test } from "bun:test";

import {
  isBenign,
  standaloneCandidate,
} from "@/api/scripts/citation-probe-candidates";

const residual = (match: string): boolean =>
  !isBenign(standaloneCandidate(match));

describe("citation probe candidates", () => {
  test("a regional-authority file number is benign", () => {
    expect(residual("č. j. KUAB 12345/2020")).toBe(false);
    expect(residual("č.j.: KUJCK 987/2019")).toBe(false);
  });

  test("an authority file number joined by non-breaking hyphens is benign", () => {
    const nb = "‑";
    expect(
      residual(`č. j. ABCD${nb}123456${nb}12/XY${nb}2020${nb}1234AB`),
    ).toBe(false);
    expect(residual(`č. j. ÚOHS${nb}S123/2019/VZ`)).toBe(false);
    expect(residual(`sp. zn. 12 C 345/2020 ÚOHS${nb}S123/2019/VZ`)).toBe(true);
    expect(residual("sp. zn. 12 C 345/2020 ÚOHS-S123/2019/VZ")).toBe(true);
  });

  test("an enforcement-officer or arbitration file is benign, a docket is not", () => {
    expect(residual("sp. zn. EX 1234/23")).toBe(false);
    expect(residual("sp.zn. EX 567/07")).toBe(false);
    expect(residual("sp. zn. SR 01234/08 zo dňa 1.2.2008")).toBe(false);
    expect(residual("sp. zn. EX 1234/23-5")).toBe(true);
    expect(residual("sp. zn. 12 Er 345/2020")).toBe(true);
    expect(residual("sp. zn. 3 EXE 1234/2015")).toBe(true);
  });

  test("a court docket followed by an authority number stays a residual", () => {
    const match = "sp. zn. 12 C 345/2020 č. j. KUAB 12345/2020";
    expect(standaloneCandidate(match)).toBe("sp. zn. 12 C 345/2020");
    expect(residual(match)).toBe(true);
    expect(isBenign(match)).toBe(false);
  });

  test("an authority number with a further segment is not benign", () => {
    expect(residual("č. j. KUAB 12345/2020/3")).toBe(true);
    expect(residual("č. j. KUAB 12345/2020-3")).toBe(true);
    expect(residual("č. j. KUAB 12345/2020 ze dne 1. 2. 2020")).toBe(false);
  });

  test("an application number with a continuing suffix is not benign", () => {
    expect(residual("sp. zn. 12345/01A")).toBe(true);
    expect(residual("sygn. akt 12345/01-2")).toBe(true);
    expect(residual("sygn. akt 12345/01 z dnia")).toBe(false);
  });

  test("a numeric application number is benign, a domestic docket is not", () => {
    expect(residual("sygn. akt 12345/01")).toBe(false);
    expect(residual("sp. zn. 12345/01")).toBe(false);
    expect(residual("sygn. akt I ACa 123/01")).toBe(true);
    expect(residual("sp. zn. 12345/2001")).toBe(true);
  });

  test("a numeric authority reference with a ten-digit head is benign", () => {
    expect(residual("č. j. 1234567890/1234-12345-123456")).toBe(false);
    expect(residual("č. j. 12345678901/1234-12345-123456")).toBe(true);
  });

  test("a court-administration file is benign, a civil docket is not", () => {
    expect(residual("sp. zn. Spr 1234/2014 z 1. mája 2014")).toBe(false);
    expect(residual("sp. zn. 1 Spr. 56/14")).toBe(false);
    expect(residual("sp. zn. Spr 1234/2014-5")).toBe(true);
    expect(residual("sp. zn. 5 Sp 123/2014")).toBe(true);
  });

  test("a procurement arbitration file is benign, a court docket is not", () => {
    expect(residual("sygn. akt UZP/ZO/0-1234/05")).toBe(false);
    expect(residual("sygn. akt UZP/ZO/O-567/07")).toBe(false);
    expect(residual("sygn. akt UZP/ZO/O- 2279/05")).toBe(false);
    expect(residual("sygn. akt UZP/ZO/0-\n2039/06")).toBe(false);
    expect(residual("sygn. akt. UZP/ZO/0 -1234/05")).toBe(false);
    expect(residual("sygn. akt UZP/ZO/ 0-567/07")).toBe(false);
    expect(residual("sygn. akt UZP/ZO/0-1234/05/A")).toBe(true);
    expect(residual("sygn. akt V CSK 123/05")).toBe(true);
  });

  test("a prosecutor-office file is benign, a criminal docket is not", () => {
    expect(residual("sp. zn. VI/2 Pz 123/07 zo dňa")).toBe(false);
    expect(residual("sp. zn.XV/2 Gn 45/09")).toBe(false);
    expect(residual("sp. zn. VI/2 Pz 123/07-5")).toBe(true);
    expect(residual("sp. zn. 2 Tdo 123/2007")).toBe(true);
  });

  test("a Czech anonymization label is benign, a numbered docket is not", () => {
    expect(residual("č. j. číslo jednací ze dne 1. 2. 2020")).toBe(false);
    expect(residual("č. j. číslo uvedený v bodě 3.2 rozsudku")).toBe(false);
    expect(residual("č.j. č. účtu ze dne 3. 4. 2019")).toBe(false);
    expect(residual("č. j. číslo")).toBe(false);
    expect(residual("č. j. číslo 12 C 345/2020")).toBe(true);
    expect(residual("č. j. 12 C 345/2020-67")).toBe(true);
  });
});
