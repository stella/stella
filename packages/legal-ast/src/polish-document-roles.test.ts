import { describe, expect, test } from "bun:test";

import {
  isPlHoldingHeading,
  isPlReasonsHeading,
  isPlSignatureBlank,
  isPlSignatureLine,
  startsWithPlOperativeVerb,
} from "./polish-document-roles";

describe("a Polish operative verb opening", () => {
  test.each([
    "oddala apelację",
    "oddalić apelację",
    "zmienić zaskarżony wyrok",
    "uchyla zaskarżony wyrok",
    "uchylić wyrok",
    "zasądza koszty postępowania",
    "zasądzić odsetki",
    "stwierdzić nieważność",
    "umorzyć postępowanie",
    "utrzymuje w mocy wyrok",
    "nakazuje zwrot",
    "nakazać zwrot",
    "nakaże zwrot",
    "odrzucić apelację",
    "ustala istnienie",
    "przyjmuje skargę do rozpoznania",
    "przyznaje świadczenie",
    "odmawia przyjęcia skargi kasacyjnej",
    "zwraca się do sądu",
    "przekazuje sprawę do ponownego rozpoznania",
    "obciążyć kosztami postępowania",
    "nie obciążyć kosztami postępowania",
    "nie obciąża kosztami",
    "nie obciążać kosztami",
    "znosi koszty wzajemnie",
    "orzeka o kosztach",
    "uznaje skargę za zasadną",
    "wymierza karę",
    "zwalnia od opłaty",
    "zakazuje prowadzenia działalności",
    "postanawia umorzyć postępowanie",
    "uchwala zasady",
    "zarządza wykonanie wyroku",
    "przyjmie skargę",
    "przekaże sprawę",
    "zniesie koszty",
  ])("recognizes the generated operative form at the start: %s", (text) => {
    expect(startsWithPlOperativeVerb(text)).toBe(true);
  });

  test.each([
    "oddalenie apelacji",
    "ustalenia faktyczne",
    "przekazanie sprawy",
    "wymierzenie kary",
    "strona przyjmuje argument",
    "poprzedzający tekst oddala powództwo",
  ])("does not match a noun, allegation, or later verb: %s", (text) => {
    expect(startsWithPlOperativeVerb(text)).toBe(false);
  });

  test("matches accented Polish forms case-insensitively", () => {
    expect(startsWithPlOperativeVerb("ZASĄDZIĆ koszty")).toBe(true);
    expect(startsWithPlOperativeVerb("obciążyć kosztami")).toBe(true);
  });
});

describe("a Polish holding heading", () => {
  test.each([
    "orzeka",
    "orzeka:",
    "orzekać",
    "postanawia",
    "postanowić",
    "postanowił",
    "uchwala",
    "uchwalić",
    "uchwalił:",
    "zarządza",
  ])("recognizes a bare holding heading: %s", (text) => {
    expect(isPlHoldingHeading(text)).toBe(true);
  });

  test.each([
    "oddala skargę",
    "orzeka o kosztach",
    "postanawia umorzyć postępowanie",
    "sąd orzeka",
  ])("does not classify an operative clause as a heading: %s", (text) => {
    expect(isPlHoldingHeading(text)).toBe(false);
  });
});

describe("a Polish signature line", () => {
  // Lines the recorded SAOS and KIO decisions sign their rulings with.
  test.each([
    "SSO Katarzyna Banko",
    "SSA Ewa Jastrzębska SSA Małgorzata Wołczańska SSO del. Tomasz Tatarczyk",
    "SSA Grażyna Czyżak SSA Lucyna Ramlo SSO del. Joanna Janiszewska-Ziołek",
    "SSO Magdalena Balion - Hajduk",
    "SSA Jan Dela SSA Jan Sokulski SSO del. Agnieszka Staniszewska- Perenc",
    "SSO Aleksandra Odoj-Jarek (spr.) SSO Lucyna Pradelska-Staniczek",
    "Przewodniczący:…………………………",
    "Przewodniczący:    ....................................",
    "Przewodnicząca:",
    "Skład orzekający Izby:",
    "P r z e w o d n i c z ą c y :",
  ])("signs: %s", (text) => {
    expect(isPlSignatureLine(text)).toBe(true);
  });

  test.each([
    // The head matter names the bench: a label followed by a name.
    "Przewodniczący: Anna Osiecka",
    "Przewodniczący: Sędzia Sądu Okręgowego Katarzyna Banko",
    // A ruling point that names a judge is still the ruling.
    "SSO Jan Kowalski zasądza od pozwanego kwotę 100 zł",
    "zasądza od pozwanego na rzecz SSO Jana Kowalskiego kwotę",
    "SSO",
    "SSO del.",
    "SSO Jan Maria Anna Zofia Kowalska",
    "Sąd Okręgowy w Gliwicach I Wydział Cywilny",
  ])("does not sign: %s", (text) => {
    expect(isPlSignatureLine(text)).toBe(false);
  });

  test("a line of dots is the blank a signature is written on", () => {
    expect(isPlSignatureBlank("………………………………")).toBe(true);
    expect(isPlSignatureBlank(". . . . . . . .")).toBe(true);
    expect(isPlSignatureBlank("…")).toBe(false);
    expect(isPlSignatureBlank("1. … oddala")).toBe(false);
  });
});

describe("the Polish reasons heading", () => {
  test.each([
    "Uzasadnienie",
    "UZASADNIENIE",
    "uzasadnienie",
    "U z a s a d n i e n i e",
    "U Z A S A D N I E N I E",
  ])("opens the reasons: %s", (text) => {
    expect(isPlReasonsHeading(text)).toBe(true);
  });

  test.each(["W uzasadnieniu odwołania", "Uzasadnieniem", "Sąd uzasadnia"])(
    "does not open them: %s",
    (text) => {
      expect(isPlReasonsHeading(text)).toBe(false);
    },
  );
});
