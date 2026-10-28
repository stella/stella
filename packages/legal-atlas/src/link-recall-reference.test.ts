import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  auditDecisionKey,
  CZ_REFERENCE_AUDIT_PROFILE,
  extractAuditReferences,
  type ReferenceAuditProfile,
} from "./link-recall-reference";

const extract = (text: string) =>
  extractAuditReferences({
    passages: [{ anchor: "body", text }],
    profile: CZ_REFERENCE_AUDIT_PROFILE,
    selfIdentifiers: [],
  });

test("independent audit recognizes Czech court families and ECLI", () => {
  const text =
    "č. j. 6 As 41/2023-72; I. ÚS 123/2020; Pl. ÚS 4/23; sp. zn. 29 Cdo 100/2022; č. j. 25 A 20/2024-35; sp. zn. 3 Nt 51/2020; ECLI:CZ:NSS:2024:6.AS.41.2023.72";
  expect(extract(text).map(({ kind, key }) => [kind, key])).toEqual([
    ["decision", "6AS41/2023"],
    ["decision", "I.ÚS123/2020"],
    ["decision", "PL.ÚS4/23"],
    ["decision", "29CDO100/2022"],
    ["decision", "25A20/2024"],
    ["decision", "3NT51/2020"],
    ["decision", "ECLI:CZ:NSS:2024:6.AS.41.2023.72"],
  ]);
  expect(extract("č. j. 6 As 41/2023-72")).toHaveLength(1);
  expect(extract("Účet 150/2002, datum 25. 1. 2024, částka 35 Kč")).toEqual([]);
});

test("Czech audit recognizes cited European dockets and foreign ECLI without sentence punctuation", () => {
  expect(
    extract(
      "C-123/24, T‑456/2023 a F–1/15; ECLI:EU:C:2024:123. ECLI:DE:BVERFG:2024:RS20240101.",
    ).map(({ key }) => key),
  ).toEqual([
    "C-123/24",
    "T-456/2023",
    "F-1/15",
    "ECLI:EU:C:2024:123",
    "ECLI:DE:BVERFG:2024:RS20240101",
  ]);
});

test("reviewed regional judgments are recognized across adjacent opening blocks", () => {
  for (const citation of ["25 A 20/2024-35", "25 A 184/2021-61"]) {
    const references = extractAuditReferences({
      passages: [
        {
          anchor: "opening-a",
          text: "Nejvyšší správní soud rozhodl o kasační stížnosti žalobce",
        },
        {
          anchor: "opening-b",
          text: `proti rozsudku Krajského soudu v Ostravě ze dne 30. 1. 2025, č. j. ${citation}.`,
        },
      ],
      profile: CZ_REFERENCE_AUDIT_PROFILE,
      selfIdentifiers: [],
    });
    expect(references.map(({ kind }) => kind)).toEqual([
      "decision",
      "reviewed-decision",
    ]);
    for (const reference of references) {
      expect(reference.anchor).toBe("opening-b");
      expect(reference.text).toBe(`č. j. ${citation}`);
    }
  }
});

test("reviewed decisions recognize appeal and constitutional complaint formulas in both Unicode forms", () => {
  for (const remedy of [
    "kasační stížnosti",
    "ústavní stížnosti",
    "dovolání",
    "odvolání",
  ]) {
    for (const decision of ["rozsudku", "usnesení"]) {
      const opening = `Soud rozhodl o ${remedy} žalobce proti ${decision} Krajského soudu v Ostravě ze dne 30. 1. 2025, č. j. 25 A 20/2024-35.`;
      const decomposed = normalizeUnicode(opening, "NFD");
      expect(decomposed).not.toBe(opening);
      for (const text of [opening, decomposed]) {
        expect(extract(text).map(({ kind, key }) => [kind, key])).toEqual([
          ["decision", "25A20/2024"],
          ["reviewed-decision", "25A20/2024"],
        ]);
      }
    }
  }
});

test("semantic cues end at the first decision and do not bleed into later references", () => {
  const references = extract(
    "O kasační stížnosti proti rozsudku č. j. 25 A 20/2024-35; dále srov. 6 As 1/2020. V předchozím řízení rozhodl soud pod sp. zn. 29 Cdo 100/2022; srov. 6 As 2/2020.",
  );
  expect(references.map(({ kind, key }) => [kind, key])).toEqual([
    ["decision", "25A20/2024"],
    ["reviewed-decision", "25A20/2024"],
    ["decision", "6AS1/2020"],
    ["decision", "29CDO100/2022"],
    ["procedural-history", "29CDO100/2022"],
    ["decision", "6AS2/2020"],
  ]);
  const distant = extractAuditReferences({
    passages: [
      { anchor: "a", text: "O kasační stížnosti proti rozsudku" },
      { anchor: "b", text: "mezera ".repeat(200) },
      { anchor: "c", text: "č. j. 25 A 20/2024-35" },
    ],
    profile: CZ_REFERENCE_AUDIT_PROFILE,
    selfIdentifiers: [],
  });
  expect(distant.map(({ kind }) => kind)).toEqual(["decision"]);
});

test("self comparison removes sheet and presentation differences without filtering ECLI variants", () => {
  expect(
    extractAuditReferences({
      passages: [
        {
          anchor: "a",
          text: "č. j. 25 A 20/2024–35; 6 As 1/2020; ECLI:CZ:NSS:2024:6.AS.1.2020.42",
        },
      ],
      profile: CZ_REFERENCE_AUDIT_PROFILE,
      selfIdentifiers: ["CZ sp. zn. 25A20/2024-99", "6 As 1/2020-18"],
    }).map(({ key }) => key),
  ).toEqual(["ECLI:CZ:NSS:2024:6.AS.1.2020.42"]);
  expect(auditDecisionKey("ECLI:CZ:NSS:2024:6.AS.1.2020-42")).toBe(
    "ECLI:CZ:NSS:2024:6.AS.1.2020-42",
  );
});

test("provisions require an explicit nearby act and retain section suffixes", () => {
  const text =
    "Podle § 65 odst. 1 zákona č. 150/2002 Sb. a § 9a zákona č. 99/1963 Sb. lze postupovat. Samotný § 10 nestačí. § 11; zákona č. 150/2002 Sb. § 12\nzákona č. 150/2002 Sb.";
  expect(extract(text).map(({ kind, key }) => [kind, key])).toEqual([
    ["provision", "150/2002:65"],
    ["provision", "99/1963:9a"],
  ]);
  expect(extract(`§ 13 ${"text ".repeat(40)}zákona č. 150/2002 Sb.`)).toEqual(
    [],
  );
  for (const actPhrase of [
    "zákona č. 150/2002 Sb.",
    "zák. č. 150/2002 Sb.",
    "č.150/2002 Sb.",
  ]) {
    expect(extract(`§ 65a odst. 1 ${actPhrase}`).map(({ key }) => key)).toEqual(
      ["150/2002:65a"],
    );
  }
});

test("provision audit excludes act identifiers separated by prose or another section", () => {
  expect(
    extract(
      "Podle § 1970 o. z. se platí úrok ve výši určené nařízením vlády č. 351/2013 Sb.",
    ),
  ).toEqual([]);
  expect(
    extract("§ 65 odst. 1 a § 66 odst. 2 zákona č. 150/2002 Sb.").map(
      ({ key }) => key,
    ),
  ).toEqual(["150/2002:66"]);
  for (const separator of ["\n", "\r\n", "\u2028", "\u2029"]) {
    expect(extract(`§ 65 odst. 1${separator}zákona č. 150/2002 Sb.`)).toEqual(
      [],
    );
  }
  expect(
    extract("§ 14b odst. 1 vyhlášky č. 177/1996 Sb.").map(({ key }) => key),
  ).toEqual(["177/1996:14b"]);
  expect(
    extract("§ 1 nařízení vlády č. 351/2013 Sb.").map(({ key }) => key),
  ).toEqual(["351/2013:1"]);
  expect(
    extract("§ 65 až 66 odst. 1, 2 písm. a) zákona č. 150/2002 Sb.").map(
      ({ key }) => key,
    ),
  ).toEqual(["150/2002:65"]);
});

test("provision audit never infers a statutory binding through arbitrary prose", () => {
  assertProperty(
    "provision audit never infers a statutory binding through arbitrary prose",
    fc.property(
      fc.array(
        fc.constantFrom("soud", "přezkoumal", "podání", "žalobce", "věc"),
        { minLength: 1, maxLength: 12 },
      ),
      fc.integer({ min: 1, max: 9999 }),
      (words, section) => {
        const text = `§ ${section} ${words.join(" ")} zákona č. 150/2002 Sb.`;
        expect(extract(text)).toEqual([]);
        expect(
          extract(`§ ${section} odst. 1 zákona č. 150/2002 Sb.`).map(
            ({ key }) => key,
          ),
        ).toEqual([`150/2002:${section}`]);
      },
    ),
  );
});

test("procedural history distinguishes a local annulment from ordinary precedent", () => {
  expect(
    extract("Srov. rozsudek NSS č. j. 6 As 1/2020-40.").map(({ kind }) => kind),
  ).toEqual(["decision"]);
  expect(
    extract(
      "NSS rozsudkem č. j. 6 As 1/2020-40 zrušil rozsudek krajského soudu.",
    ).map(({ kind }) => kind),
  ).toEqual(["decision", "procedural-history"]);
  expect(
    extract(
      "Srov. rozsudek NSS č. j. 6 As 1/2020-40. V předchozím řízení nebylo rozhodnuto.",
    ).map(({ kind }) => kind),
  ).toEqual(["decision"]);
});

test("profiles supply independent jurisdiction grammar without changing the engine", () => {
  const profile = {
    country: "XY",
    decisionPatterns: [String.raw`XY-\d{4}-\d+`],
    reviewedCue: "appeal against",
    proceduralCue: "earlier proceedings",
    provisionPattern: String.raw`Article (?<section>\d+) of Act (?<act>\d+)/(?<year>\d{4})`,
  } as const satisfies ReferenceAuditProfile;
  expect(
    extractAuditReferences({
      passages: [
        {
          anchor: "foreign",
          text: "An appeal against XY-2024-123; Article 4 of Act 8/2020.",
        },
      ],
      profile,
      selfIdentifiers: [],
    }).map(({ kind, key }) => [kind, key]),
  ).toEqual([
    ["decision", "XY-2024-123"],
    ["reviewed-decision", "XY-2024-123"],
    ["provision", "8/2020:4"],
  ]);
});

test("audit spans preserve UTF16 source slices across Unicode presentation variants", () => {
  assertProperty(
    "audit spans preserve UTF16 source slices across Unicode presentation variants",
    fc.property(
      fc.constantFrom(" ", "\t", "\n", "\u00a0", "  "),
      fc.constantFrom("-", "–", "—", "−"),
      fc.integer({ min: 1, max: 99_999 }),
      fc.string({ maxLength: 30 }),
      (space, dash, number, prefix) => {
        const citation = `č.${space}j.${space}25${space}A${space}${number}/${space}2024${dash}35`;
        const statute = `§${space}65a zákona č. 150/2002 Sb.`;
        const nfdCitation = normalizeUnicode(citation, "NFD");
        expect(nfdCitation).not.toBe(citation);
        for (const printed of [citation, nfdCitation]) {
          const text = `😀${prefix}; ${printed}; ${normalizeUnicode(statute, "NFD")}`;
          const result = extract(text);
          expect(result.map(({ kind, key }) => [kind, key])).toEqual([
            ["decision", `25A${number}/2024`],
            ["provision", "150/2002:65a"],
          ]);
          for (const reference of result) {
            expect(text.slice(reference.start, reference.end)).toBe(
              reference.text,
            );
            expect(reference.start).toBeGreaterThanOrEqual(0);
            expect(reference.end).toBeLessThanOrEqual(text.length);
            expect(reference.context).toContain(reference.text);
          }
          expect(result.at(0)?.text).toBe(printed);
          expect(extract(text)).toEqual(result);
        }
      },
    ),
  );
});

test("comparison identity is a fixed point across whitespace prefix and sheet variants", () => {
  assertProperty(
    "comparison identity is a fixed point across whitespace prefix and sheet variants",
    fc.property(
      fc.constantFrom(" ", "\t", "\n", "\u00a0"),
      fc.constantFrom("č. j.", "sp. zn.", "CZ: č. j.", "cz sp. zn."),
      fc.constantFrom("-", "–", "—", "−"),
      fc.integer({ min: 1, max: 99_999 }),
      (space, prefix, dash, number) => {
        const printed = normalizeUnicode(
          `${prefix}${space}I.${space}ÚS${space}${number}/${space}2024 ${dash} 12`,
          "NFD",
        );
        const key = auditDecisionKey(printed);
        expect(key).toBe(`I.ÚS${number}/2024`);
        expect(auditDecisionKey(key)).toBe(key);
        expect(
          extractAuditReferences({
            passages: [{ anchor: "a", text: `I. ÚS ${number}/2024-99` }],
            profile: CZ_REFERENCE_AUDIT_PROFILE,
            selfIdentifiers: [printed],
          }),
        ).toEqual([]);
      },
    ),
  );
});
