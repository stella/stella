import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CZ_CLOSING_RE,
  CZ_JUDGE_NAME_RE,
  CZ_JUDGE_TITLE_RE,
} from "@stll/legal-ast/czech-document-roles";
import { assertProperty } from "@stll/property-testing";

describe("CZ_CLOSING_RE", () => {
  const matches = [
    "V Brně dne 6. ledna 2016",
    "V Brně dne 25. 10. 2018",
    "V Praze dne 15. března 2025",
    "V Brně 13. září  2006",
    "V Olomouci dne 1. 2. 2020",
    "Brno 15. května 2023",
  ];

  const nonMatches = [
    "Nejvyšší soud projednal",
    "Podle § 4a odst. 3",
    "JUDr. Jan Engelmann",
    "předseda senátu",
  ];

  for (const input of matches) {
    test(`matches: "${input}"`, () => {
      expect(CZ_CLOSING_RE.test(input)).toBe(true);
    });
  }

  for (const input of nonMatches) {
    test(`rejects: "${input}"`, () => {
      expect(CZ_CLOSING_RE.test(input)).toBe(false);
    });
  }
});

describe("CZ_JUDGE_NAME_RE", () => {
  const matches = [
    "JUDr. Jan Engelmann",
    "Mgr. Tomáš Braun",
    "doc. Karel Šimka",
    "prof. Pavel Kučera",
    "PhDr. Marie Nováková",
    "Ing. Petr Svoboda",
    "Bc. Jana Dvořáková",
    "RNDr. Pavel Novotný",
    "MUDr. Lucie Králová",
  ];

  const nonMatches = [
    "předseda senátu",
    "V Brně dne 6. ledna 2016",
    "Nejvyšší soud",
  ];

  for (const input of matches) {
    test(`matches: "${input}"`, () => {
      expect(CZ_JUDGE_NAME_RE.test(input)).toBe(true);
    });
  }

  for (const input of nonMatches) {
    test(`rejects: "${input}"`, () => {
      expect(CZ_JUDGE_NAME_RE.test(input)).toBe(false);
    });
  }
});

describe("CZ_JUDGE_TITLE_RE", () => {
  const matches = [
    "předseda senátu",
    "předsedkyně senátu",
    "předsedkyně senátu:",
    "Předseda senátu:",
    "soudce zpravodaj",
    "soudkyně zpravodaj",
    "samosoudce",
    "samosoudkyně",
    "v. r.",
    "v.r.",
    "JUDr. Jan Engelmann v. r.",
  ];

  const nonMatches = [
    "JUDr. Jan Engelmann",
    "V Brně dne 6. ledna 2016",
    "Nejvyšší soud",
    "Proti tomuto rozhodnutí",
    "předsedy senátu",
    "Městský soud v Praze rozhodl samosoudcem Mgr. Janem Novákem",
  ];

  for (const input of matches) {
    test(`matches: "${input}"`, () => {
      expect(CZ_JUDGE_TITLE_RE.test(input)).toBe(true);
    });
  }

  for (const input of nonMatches) {
    test(`rejects: "${input}"`, () => {
      expect(CZ_JUDGE_TITLE_RE.test(input)).toBe(false);
    });
  }
});

describe("CZ_JUDGE_TITLE_RE whole-word property", () => {
  const nameArb = fc.constantFrom(
    "Mgr. Jan Novák",
    "JUDr. Jana Nováková",
    "Ing. Petr Svoboda",
  );
  const declinedArb = fc.constantFrom(
    "samosoudcem",
    "samosoudkyní",
    "samosoudci",
    "předsedou senátu",
    "předsedy senátu",
    "předsedovi senátu",
  );
  const titleArb = fc.constantFrom(
    "předseda senátu",
    "předsedkyně senátu",
    "samosoudce",
    "samosoudkyně",
  );

  test("declined forms never match", () => {
    assertProperty(
      "legal-ast.cz-judge-title.declined-forms",
      fc.property(
        declinedArb,
        nameArb,
        fc.boolean(),
        (declined, name, nameFirst) => {
          expect(
            CZ_JUDGE_TITLE_RE.test(
              nameFirst
                ? `${name}, ${declined}`
                : `rozhodl ${declined} ${name}`,
            ),
          ).toBe(false);
        },
      ),
    );
  });

  test("nominative titles on a short line with a name match", () => {
    assertProperty(
      "legal-ast.cz-judge-title.nominative-forms",
      fc.property(titleArb, nameArb, fc.boolean(), (title, name, nameFirst) => {
        expect(
          CZ_JUDGE_TITLE_RE.test(
            nameFirst ? `${name}, ${title}` : `${title} ${name}`,
          ),
        ).toBe(true);
      }),
    );
  });
});
