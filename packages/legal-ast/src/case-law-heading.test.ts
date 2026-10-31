import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { caseLawSectionHeading, labelledHeading } from "./case-law-heading";

describe("case-law section heading", () => {
  test("classifies Roman sections and lettered subsections", () => {
    expect(caseLawSectionHeading("VIII. Vlastní přezkum")).toEqual({
      level: 3,
    });
    expect(caseLawSectionHeading("VIII. A) Tzv. data retention")).toEqual({
      level: 4,
    });
  });

  test("keeps a title that ends in the citation of the act it names", () => {
    // IV. ÚS 1394/24: the full stop belongs to the collection's abbreviation.
    expect(
      caseLawSectionHeading(
        "III. B. Neplatnost nacistické konfiskace a uplatnění nároku na restituci podle zákona č. 128/1946 Sb.",
      ),
    ).toEqual({ level: 3 });
    expect(
      caseLawSectionHeading(
        "VI. B. Účel a podmínky restitučního nároku podle § 2 odst. 2 zákona č. 243/1992 Sb.",
      ),
    ).toEqual({ level: 3 });
    expect(labelledHeading("IV. Smlouva č. 52/1959 Sb. m. s.")?.title).toBe(
      "Smlouva č. 52/1959 Sb. m. s.",
    );
    expect(labelledHeading("2. Zákon č. 543/2002 Z. z.")?.title).toBe(
      "Zákon č. 543/2002 Z. z.",
    );
  });

  test("an act's citation at the end does not make a ruling item a title", () => {
    expect(
      caseLawSectionHeading(
        "IX. Řízení se zastavuje podle zákona č. 99/1963 Sb.",
      ),
    ).toBeNull();
    expect(
      caseLawSectionHeading("VII. Žaloba se zamítá podle § 5 odst. 2."),
    ).toBeNull();
    expect(labelledHeading("3. Soud rozhodl podle § 5 odst. 2.")).toBeNull();
  });

  test("leaves prose and implausibly long labels as paragraphs", () => {
    expect(caseLawSectionHeading("Text odůvodnění.")).toBeNull();
    expect(
      caseLawSectionHeading(`I. ${"Velmi dlouhý název ".repeat(20)}`),
    ).toBeNull();
  });
});

describe("section heading title shape", () => {
  test.each([
    "I. Žalovaný je povinen zaplatit žalobci částku",
    "II. Ve zbytku se žaloba zamítá",
    "III. Rozsudek se ruší",
    "IV. Výrok se mění",
    "V. Rozsudek se potvrzuje",
    "VI. Úhrada nákladů zaplatit",
    "VII. Žaloba se zamítá.",
    "VIII. Výrok o nákladech;",
  ])("leaves %j as text", (text) => {
    expect(caseLawSectionHeading(text)).toBeNull();
  });

  const romanArb = fc.constantFrom("I", "II", "III", "IV", "V", "IX", "XII");
  const wordArb = fc.constantFrom(
    "Žalovaný",
    "je",
    "povinen",
    "se",
    "zamítá",
    "ruší",
    "mění",
    "potvrzuje",
    "zaplatit",
    "Vlastní",
    "přezkum",
    "soud",
    "A)",
    "žaloba",
  );
  const endArb = fc.constantFrom("", ".", ";", ",", ":");

  assertProperty(
    "a promoted heading never ends a sentence or carries an operative verb",
    fc.property(
      romanArb,
      fc.array(wordArb, { minLength: 1, maxLength: 8 }),
      endArb,
      (numeral, words, end) => {
        const text = `${numeral}. ${words.join(" ")}${end}`;
        if (caseLawSectionHeading(text) === null) {
          return;
        }
        expect(text).not.toMatch(/[.;]$/u);
        expect(text).not.toMatch(
          /je povinen|se zamítá|se ruší|se mění|se potvrzuje|zaplatit/u,
        );
      },
    ),
  );
});

describe("labelled heading", () => {
  test.each([
    ["I. Dovolání a vyjádření k němu", "I", "Dovolání a vyjádření k němu"],
    ["I.\nDovolání a vyjádření k němu", "I", "Dovolání a vyjádření k němu"],
    ["I.  \n  Dovolání a vyjádření k němu", "I", "Dovolání a vyjádření k němu"],
    ["4. Závěr a náklady řízení", "4", "Závěr a náklady řízení"],
    ["III.\nPřípustnost dovolání", "III", "Přípustnost dovolání"],
  ])("reads %j as one heading", (text, label, title) => {
    expect(labelledHeading(text)).toEqual({
      label,
      title,
      text: `${label}. ${title}`,
    });
  });

  test("reads a numeral and title on two lines as the same text as on one", () => {
    expect(labelledHeading("II.\nPřípustnost dovolání")?.text).toBe(
      labelledHeading("II. Přípustnost dovolání")?.text,
    );
  });

  test.each([
    "I. Dovolání obviněných se odmítá.",
    "1. Žalobce se domáhá zaplacení částky.",
    "I. Rozsudek se zrušuje;",
    "I.",
    "Dovolání a vyjádření k němu",
    "1. žalobce se domáhá",
    `I. ${"Velmi dlouhý název ".repeat(20)}`,
  ])("leaves %j to its caller as text", (text) => {
    expect(labelledHeading(text)).toBeNull();
  });
});
