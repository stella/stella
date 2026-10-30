import { describe, expect, test } from "bun:test";

import {
  isPlHoldingHeading,
  startsWithPlOperativeVerb,
} from "./pl-operative-verbs";

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
