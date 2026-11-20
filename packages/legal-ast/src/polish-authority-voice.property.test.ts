/**
 * Properties of the Polish role grammar over an authority's own letter: the
 * ruling it states in its own voice, and the instruction on the remedy
 * against it, as the tax ordinance words them.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  isPlAppealInstruction,
  isPlInstructionHeading,
  statesPlAuthorityRuling,
} from "./polish-document-roles.js";

const AUTHORITIES = [
  "Dyrektor Krajowej Informacji Skarbowej",
  "Szef Krajowej Administracji Skarbowej",
  "Minister Finansów",
];
/** The operative verb after the authority's name, as its letters print it. */
const THIRD_PERSON = ["odmawia", "stwierdza", "zmienia", "uchyla", "wydaje"];
/** The authority signing its own letter. */
const FIRST_PERSON = [
  "stwierdzam",
  "zmieniam",
  "odmawiam",
  "uchylam",
  "uznaję",
];
/** The ruling reported as done, as an information about it prints it. */
const REPORTED = ["wydał", "odmówił", "stwierdził", "zmienił", "uchyliła"];
const OBJECTS = [
  "wydania opinii w sprawie opodatkowania wyrównawczego.",
  "opinię zabezpieczającą.",
  ", że stanowisko Wnioskodawcy jest prawidłowe.",
  "interpretację indywidualną z urzędu.",
];
/** Head matter around a ruling: words that rule nothing. */
const HEAD_MATTER_WORDS = [
  "wniosek",
  "z",
  "dnia",
  "2026",
  "r.",
  "o",
  "wydanie",
  "opinii",
  "zabezpieczającej",
  "w",
  "sprawie",
  "podatku",
  "Spółka",
  "Dyrektor",
  "wydaje się",
  "stwierdzenie",
  "wydania",
];

describe("an authority's ruling in its own voice", () => {
  test("is read in the third person, the first, and reported as done", () => {
    assertProperty(
      "is read in the third person, the first, and reported as done",
      fc.property(
        fc.constantFrom(...AUTHORITIES),
        fc.constantFrom(...THIRD_PERSON, ...REPORTED),
        fc.constantFrom(...FIRST_PERSON),
        fc.constantFrom(...OBJECTS),
        (authority, verb, firstPerson, object) => {
          expect(
            statesPlAuthorityRuling(`${authority} ${verb} ${object}`),
          ).toBe(true);
          expect(
            statesPlAuthorityRuling(
              `Działając na podstawie art. 14a § 1, ${firstPerson} ${object}`,
            ),
          ).toBe(true);
        },
      ),
    );
  });

  test("is not read in a line that rules nothing", () => {
    assertProperty(
      "is not read in a line that rules nothing",
      fc.property(
        fc.array(fc.constantFrom(...HEAD_MATTER_WORDS), {
          minLength: 1,
          maxLength: 12,
        }),
        (words) => {
          expect(statesPlAuthorityRuling(words.join(" "))).toBe(false);
        },
      ),
    );
  });
});

const THIS_DECISION = [
  "niniejsze postanowienie",
  "niniejszą decyzję",
  "niniejszą interpretację",
];
const REMEDIES = ["zażalenie", "skarga", "odwołanie"];
const LIES = ["przysługuje", "służy"];

describe("the instruction on the remedy", () => {
  test("is read wherever the remedy lies against this decision", () => {
    assertProperty(
      "is read wherever the remedy lies against this decision",
      fc.property(
        fc.constantFrom(...THIS_DECISION),
        fc.constantFrom(...LIES),
        fc.constantFrom(...REMEDIES),
        (decision, lies, remedy) => {
          expect(
            isPlAppealInstruction(
              `Na ${decision} ${lies} ${remedy} do Dyrektora Krajowej Informacji Skarbowej – w terminie 7 dni od jego doręczenia.`,
            ),
          ).toBe(true);
          // A remedy against another decision is no instruction on this one.
          expect(
            isPlAppealInstruction(
              `Na postanowienie sądu pierwszej instancji ${lies} ${remedy}.`,
            ),
          ).toBe(false);
        },
      ),
    );
  });

  test("heads the instructions when it names the remedy, and no other", () => {
    assertProperty(
      "heads the instructions when it names the remedy, and no other",
      fc.property(
        fc.constantFrom("Pouczenie", "POUCZENIE"),
        fc.constantFrom(
          " o prawie do zażalenia",
          " o prawie do wniesienia skargi na interpretację",
          " o prawie do wniesienia odwołania",
          "",
        ),
        (word, remedy) => {
          expect(isPlInstructionHeading(`${word}${remedy}`)).toBe(true);
          expect(
            isPlInstructionHeading(`${word} o funkcji ochronnej interpretacji`),
          ).toBe(false);
        },
      ),
    );
  });
});
