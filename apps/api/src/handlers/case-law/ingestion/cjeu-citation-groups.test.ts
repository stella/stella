import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  CJEU_RANGE_MAX_CASES,
  CJEU_RANGE_REFUSALS,
  readCjeuCitationGroups,
} from "./cjeu-citation-groups";

const caseNumbersOf = (text: string, language?: string) =>
  readCjeuCitationGroups(text, language).groups.map(({ members, ecli }) => ({
    numbers: members.map(({ caseNumber, role }) => `${caseNumber}:${role}`),
    ecli: ecli?.text ?? null,
  }));

describe("ranges", () => {
  // The same reference as every official language prints it.
  const RANGES: readonly (readonly [string, string, string])[] = [
    ["bg", "C‑159/12 до C‑161/12", "bg"],
    ["cs", "C‑159/12 až C‑161/12", "cs"],
    ["da", "C‑159/12 til C‑161/12", "da"],
    ["de", "C‑159/12 bis C‑161/12", "de"],
    ["el", "C‑159/12 έως C‑161/12", "el"],
    ["en", "C‑159/12 to C‑161/12", "en"],
    ["es", "C‑159/12 a C‑161/12", "es"],
    ["et", "C‑159/12 kuni C‑161/12", "et"],
    ["fi", "C‑159/12–C‑161/12", "fi"],
    ["fr", "C‑159/12 à C‑161/12", "fr"],
    ["ga", "C‑159/12 go C‑161/12", "ga"],
    ["hr", "C‑159/12 do C‑161/12", "hr"],
    ["hu", "C‑159/12–C‑161/12", "hu"],
    ["it", "C‑159/12 a C‑161/12", "it"],
    ["lt", "C‑159/12 iki C‑161/12", "lt"],
    ["lv", "C‑159/12 līdz C‑161/12", "lv"],
    ["mt", "C‑159/12 sa C‑161/12", "mt"],
    ["nl", "C‑159/12 tot en met C‑161/12", "nl"],
    ["pl", "C‑159/12 do C‑161/12", "pl"],
    ["pt", "C‑159/12 a C‑161/12", "pt"],
    ["ro", "C‑159/12 la C‑161/12", "ro"],
    ["sk", "C‑159/12 až C‑161/12", "sk"],
    ["sl", "C‑159/12 do C‑161/12", "sl"],
    ["sv", "C‑159/12 till C‑161/12", "sv"],
  ];

  test.each(RANGES)(
    "%s: a range names every case between its ends",
    (_label, range, language) => {
      expect(
        caseNumbersOf(`(${range}, EU:C:2013:791, bod 25)`, language),
      ).toEqual([
        {
          numbers: [
            "C‑159/12:printed",
            "C‑160/12:range-interior",
            "C‑161/12:printed",
          ],
          ecli: "EU:C:2013:791",
        },
      ]);
    },
  );

  test("a range without an ECLI still names every case", () => {
    expect(caseNumbersOf("spojené věci T‑101/05 až T‑104/05")).toEqual([
      {
        numbers: [
          "T‑101/05:printed",
          "T‑102/05:range-interior",
          "T‑103/05:range-interior",
          "T‑104/05:printed",
        ],
        ecli: null,
      },
    ]);
  });

  test("Czech and Slovak `a` joins two cases; Spanish `a` ranges them", () => {
    const text = "C‑411/10 a C‑413/10, EU:C:2011:865";
    for (const language of ["cs", "sk", undefined]) {
      expect(caseNumbersOf(text, language)).toEqual([
        {
          numbers: ["C‑411/10:printed", "C‑413/10:printed"],
          ecli: "EU:C:2011:865",
        },
      ]);
    }
    expect(caseNumbersOf(text, "es")).toEqual([
      {
        numbers: [
          "C‑411/10:printed",
          "C‑412/10:range-interior",
          "C‑413/10:printed",
        ],
        ecli: "EU:C:2011:865",
      },
    ]);
  });

  test.each([
    ["C‑1/12 to T‑3/12", CJEU_RANGE_REFUSALS.crossesCourt],
    ["C‑1/12 to C‑3/13", CJEU_RANGE_REFUSALS.crossesYear],
    ["C‑5/12 to C‑3/12", CJEU_RANGE_REFUSALS.notAscending],
    ["C‑1/12 to C‑900/12", CJEU_RANGE_REFUSALS.exceedsSpan],
  ] as const)(
    "%s is refused as a range with a typed reason and keeps its ends",
    (range, reason) => {
      const reading = readCjeuCitationGroups(`${range}, EU:C:2013:1`);
      expect(reading.refusals).toEqual([
        expect.objectContaining({ reason, printed: range }),
      ]);
      expect(
        reading.groups.flatMap(({ members }) =>
          members.map(({ role }) => role),
        ),
      ).toEqual(["printed", "printed"]);
    },
  );

  test("a range of exactly the span cap is read; one more is refused", () => {
    const at = readCjeuCitationGroups(
      `C‑1/12 to C‑${String(CJEU_RANGE_MAX_CASES)}/12`,
    );
    expect(at.refusals).toEqual([]);
    expect(at.groups[0]?.members).toHaveLength(CJEU_RANGE_MAX_CASES);
    const over = readCjeuCitationGroups(
      `C‑1/12 to C‑${String(CJEU_RANGE_MAX_CASES + 1)}/12`,
    );
    expect(over.refusals.map(({ reason }) => reason)).toEqual([
      CJEU_RANGE_REFUSALS.exceedsSpan,
    ]);
  });

  test("property: a range reads exactly the cases from its first end to its last", () => {
    assertProperty(
      "a range reads exactly the cases from its first end to its last",
      fc.property(
        fc.constantFrom("C", "T", "F"),
        fc.integer({ min: 1, max: 900 }),
        fc.integer({ min: 1, max: CJEU_RANGE_MAX_CASES - 1 }),
        fc.integer({ min: 0, max: 99 }),
        fc.constantFrom(" to ", " bis ", " až ", " à ", "–", " – "),
        fc.constantFrom("-", "‑", "–"),
        (letter, from, extra, yearNumber, word, dash) => {
          const year = String(yearNumber).padStart(2, "0");
          const to = from + extra;
          const text = `${letter}${dash}${String(from)}/${year}${word}${letter}${dash}${String(to)}/${year}, EU:${letter}:2020:1`;
          const reading = readCjeuCitationGroups(text);
          expect(reading.refusals).toEqual([]);
          expect(
            reading.groups.flatMap(({ members }) =>
              members.map(({ caseNumber }) => caseNumber),
            ),
          ).toEqual(
            Array.from(
              { length: to - from + 1 },
              (_, offset) => `${letter}${dash}${String(from + offset)}/${year}`,
            ),
          );
        },
      ),
    );
  });
});

describe("joined cases", () => {
  test.each([
    ["cs", "C‑570/07 a C‑571/07"],
    ["de", "C‑570/07 und C‑571/07"],
    ["en", "C‑570/07 and C‑571/07"],
    ["es", "C‑570/07 y C‑571/07"],
    ["fr", "C‑570/07 et C‑571/07"],
    ["hu", "C‑570/07 és C‑571/07"],
    ["it", "C‑570/07 e C‑571/07"],
    ["lv", "C‑570/07 un C‑571/07"],
    ["nl", "C‑570/07 en C‑571/07"],
    ["pl", "C‑570/07 i C‑571/07"],
    ["ro", "C‑570/07 și C‑571/07"],
    ["sl", "C‑570/07 in C‑571/07"],
    ["sv", "C‑570/07 och C‑571/07"],
    ["el", "C‑570/07 και C‑571/07"],
  ] as const)("%s: each joined case is one member", (language, joined) => {
    expect(caseNumbersOf(`${joined}, EU:C:2010:300, bod 40`, language)).toEqual(
      [
        {
          numbers: ["C‑570/07:printed", "C‑571/07:printed"],
          ecli: "EU:C:2010:300",
        },
      ],
    );
  });

  test("an ECLI belongs to the numbers right before it, not the next reference's", () => {
    expect(
      caseNumbersOf(
        "Blanco Pérez, C‑570/07 a C‑571/07, EU:C:2010:300, bod 40, a Venturini, C‑159/12 až C‑161/12, EU:C:2013:791, body 25 a 26",
        "cs",
      ),
    ).toEqual([
      {
        numbers: ["C‑570/07:printed", "C‑571/07:printed"],
        ecli: "EU:C:2010:300",
      },
      {
        numbers: [
          "C‑159/12:printed",
          "C‑160/12:range-interior",
          "C‑161/12:printed",
        ],
        ecli: "EU:C:2013:791",
      },
    ]);
  });

  test("the full ECLI spelling is read as the printed ECLI", () => {
    expect(caseNumbersOf("C‑1/20, ECLI:EU:C:2021:5")).toEqual([
      { numbers: ["C‑1/20:printed"], ecli: "ECLI:EU:C:2021:5" },
    ]);
  });
});

describe("numbers without a registry letter", () => {
  test("pre-1989 numbers are read in a reference that prints its ECLI", () => {
    expect(caseNumbersOf("15/76, 16/76 and 17/76, EU:C:1979:1")).toEqual([
      {
        numbers: ["15/76:printed", "16/76:printed", "17/76:printed"],
        ecli: "EU:C:1979:1",
      },
    ]);
  });

  test("a directive, a regulation or a report number is never read", () => {
    expect(
      caseNumbersOf(
        "směrnice 2004/38 a nařízení č. 604/2013, zpráva 1/96 a 65/65/EHS",
      ),
    ).toEqual([]);
    // Beside a lettered case number a bare one is a directive's, ECLI or not.
    expect(
      caseNumbersOf("směrnice 2003/86 a C‑578/08, EU:C:2010:117", "cs"),
    ).toEqual([{ numbers: ["C‑578/08:printed"], ecli: "EU:C:2010:117" }]);
  });
});
