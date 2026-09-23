import { describe, expect, test } from "bun:test";

import {
  DECISION_DOCKET_GRAMMARS,
  polishAdministrativeDocketOf,
} from "./decision-docket-grammar";

describe("polishAdministrativeDocketOf", () => {
  test.each([
    // Regional courts: every register, a non-ASCII seat, Warsaw's eighth division.
    "I SA/Wa 123/20",
    "II SAB/Wa 11/04",
    "III SA/Gl 1234/19",
    "II SPP/Wa 1/20",
    "I SO/Kr 3/21",
    "II SA/Łd 123/20",
    "VIII SA/Wa 5/20",
    "II SA / Wa 2016/05",
    // NSA: each chamber, register and resolution mark.
    "II FSK 1226/21",
    "I OSK 2186/14",
    "II GSK 5/20",
    "II GZ 15/04",
    "I OW 10/04",
    "I OZ 45/23",
    "II GPP 1/19",
    "I FNP 1/20",
    "I ONP 4/06",
    "II GPS 1/17",
    "I OPS 3/22",
    "II GOK 2/18",
    // Before the 2004 reform, including the `Ł` seat and joined ranges.
    "SA/Wr 1234/98",
    "SA/Ł 1234/98",
    "I SA/Łd 12/99",
    "SA/Ka 12/99",
    "III SA 1234/01",
    "II SAB 12/99",
    "I SA 1234-1236/98",
    "SA/Wr 12–14/99",
    "FPS 1/99",
    "OPS 3/98",
    "FPK 2/99",
    "OPK 1/97",
    // A division glued to its register, a seat in capitals.
    "IISA/WR 12/01",
    "IIISA 1234/01",
    // The seatless Warsaw form through the 2004-2006 transition.
    "IV SA 123/04",
    "V SA 12/05",
    "VI SA 1/06",
    "IV SAB 12/05",
    "IV SA 123-125/04",
    // NSA marks without a division, 2004-2005.
    "FSK 123/04",
    "OSK 1/05",
    "GSK 12/04",
    "GZ 1/04",
    "OZ 2/05",
    "FZ 3/04",
    "OW 4/05",
    // The electoral-complaint register.
    "II OKW 1/24",
    // Bare pre-reform marks.
    "SA 123/98",
    "OSA 12/03",
    "FSA 1/04",
    // Division-less delay complaints and resolutions, 2004-2005.
    "OPP 3/04",
    "FPP 1/04",
    "GPP 2/04",
    "FPS 1/04",
    "OPS 2/04",
    // A joined range of pre-2004 resolutions.
    "OPK 12-14/98",
  ])("reads %p as an administrative docket", (caseNumber) => {
    expect(polishAdministrativeDocketOf(caseNumber)).not.toBeNull();
  });

  test.each([
    // Common courts and the Supreme Court.
    "I C 123/20",
    "II AKa 12/19",
    "III CZP 1/20",
    "II CSK 123/20",
    "XXIII Gz 12/20",
    "III A/Ua 12/20",
    // An NSA mark in the wrong case or under a division the NSA lacks.
    "II Fsk 1226/21",
    "IV FSK 1/20",
    // An unknown register, a register without its chamber letter, an
    // unknown seat, a seat in lower case, a ninth regional division.
    "I XSK 1/20",
    "I OK 1/20",
    "I SA/Xy 1/20",
    "I SA/wr 1/20",
    "IX SA/Wa 1/20",
    // Seatless and bare resolution forms after the reform.
    "III SA 1234/07",
    "OPS 3/06",
    "OPS 123/98",
    // A leading number before something that is not a docket.
    "12/II C 1/20",
    // Common-court and Supreme Court dockets under divisions IV-VI.
    "IV Ca 12/20",
    "V ACa 1/20",
    "IV CSK 12/20",
    "V KK 1/20",
    "VI Ka 12/05",
    "KIO 1234/24",
    // Transitional forms outside their years or divisions.
    "IV SA 12/20",
    "VII SA 1/04",
    "FSK 12/07",
    "FSK 12/03",
    "SA 12/05",
    "OSA 12/08",
    // A company name ending in `SA` ahead of a number.
    "Bank SA 12/99",
  ])("does not read %p as an administrative docket", (caseNumber) => {
    expect(polishAdministrativeDocketOf(caseNumber)).toBeNull();
  });

  test("drops a leading number only ahead of a whole docket", () => {
    expect(polishAdministrativeDocketOf("12/II SA/Po 1234/99")).toBe(
      "II SA/Po 1234/99",
    );
    expect(polishAdministrativeDocketOf("II SA/Po 1234/99")).toBe(
      "II SA/Po 1234/99",
    );
  });
});

describe("the Polish search grammar", () => {
  const key = (docket: string): string | null => {
    const parsed = DECISION_DOCKET_GRAMMARS.POL.parse(docket);
    return parsed === null ? null : parsed.canonical;
  };

  test.each([
    ["SA/Wr 1234/98", "sa/wr 1234/98"],
    ["SA/Ł 1234/98", "SA / Ł 1234/98"],
    ["FPS 1/99", "fps 1/99"],
    ["I SA/Wa 123/20", "i sa wa 123/20"],
    ["II SA/Wr 12/01", "IISA/WR 12/01"],
    ["KIO 1234/24", "kio 1234/24"],
    ["KIO/UZP 1188/08", "KIO UZP 1188/08"],
    ["KIO 2845/25, KIO 2846/25", "kio 2845/25,KIO 2846/25"],
    ["IV SA 123/04", "IVSA 123/04"],
    ["FSK 123/04", "fsk 123/04"],
    ["SA 123/98", "sa 123/98"],
    ["II OKW 1/24", "ii okw 1/24"],
    ["OPK 12-14/98", "opk 12–14/98"],
    // Tribunal dockets: dot and letter case do not split them.
    ["K 2/26", "K. 2/26"],
    ["SK 12/20", "SK. 12/20"],
    ["Ts 123/19", "TS 123/19"],
    ["Kpt 1/17", "KPT 1/17"],
    ["U 4/86", "U.4/86"],
    // Authority file numbers.
    ["DKN.5131.6.2024", " DKN.5131.6.2024 "],
    ["ZSOŚS.440.82.2019", "ZSOŚS.440.82.2019"],
    ["DKE.561.1.2020", "DKE.561.1.2020"],
  ])("accepts %p and keys %p the same", (docket, variant) => {
    expect(key(docket)).not.toBeNull();
    expect(key(variant)).toBe(key(docket));
  });

  test("keeps distinct dockets apart", () => {
    const keys = [
      "SA/Wr 1234/98",
      "I SA/Wr 1234/98",
      "KIO 1188/08",
      "KIO/UZP 1188/08",
      "KIO 2845/25",
      "KIO 2845/25, KIO 2846/25",
      // A division-less mark is not assumed to be either division's docket.
      "FSK 123/04",
      "I FSK 123/04",
      "II FSK 123/04",
      // Nor a seatless docket the seated one.
      "IV SA 123/04",
      "IV SA/Wa 123/04",
      // A Tribunal docket is not a common court's under a division.
      "K 12/20",
      "II K 12/20",
      "SK 12/20",
      "I SK 12/20",
      "W 3/20",
      "Kw 3/20",
      // The dots between an authority file number's groups are its own.
      "DKN.5131.6.2024",
      "DKN.513.16.2024",
    ].map(key);
    expect(keys).not.toContain(null);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test.each([
    "SA/Xy 1234/98",
    "OPS 3/06",
    "KIO 2845/2025",
    "KIO 2845/25,",
    "UZP 1188/08",
    // Tribunal prefixes are read as printed, and only those prefixes.
    "k 2/26",
    "sk 12/20",
    "X 2/26",
    "Kx 2/26",
    // Statute references and tax-ruling signatures are not file numbers.
    "art. 5.1",
    "Dz.U.2024.1061",
    "DZ.U.2024.1061",
    "0114-KDIP1-2.4012.123.2024.1.AB",
    "KDIP1.4012.123.2024",
    // One group, a short year, lower case, a code too short or too long.
    "DKN.5131.2024",
    "DKN.5131.6.24",
    "dkn.5131.6.2024",
    "D.5131.6.2024",
    "ABCDEFG.1.2.2024",
  ])("rejects %p", (text) => {
    expect(key(text)).toBeNull();
  });
});
