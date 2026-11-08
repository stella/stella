import { describe, expect, test } from "bun:test";

import {
  containsPlOperativeVerb,
  isPlCompositionLine,
  isPlHoldingHeading,
  isPlLegalBasisRuling,
  isPlReasonsHeading,
  isPlRecitalLine,
  isPlSignatureBlank,
  isPlSignatureLine,
  namesPlDocumentType,
  opensPlRuling,
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
    "ustalił:",
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

describe("the Polish head matter before the ruling", () => {
  test.each([
    "po rozpoznaniu w sprawie przeciwko skazanemu D. P.",
    "po przeprowadzeniu postępowania administracyjnego w sprawie przetwarzania danych osobowych przez Burmistrza G., Prezes Urzędu Ochrony Danych Osobowych",
    "Na podstawie art. 104 § 1 ustawy z dnia 14 czerwca 1960 r. Kodeks postępowania administracyjnego,",
    "na podstawie art. 437 § 2 kpk",
  ])("introduces the ruling: %s", (text) => {
    expect(isPlRecitalLine(text)).toBe(true);
  });

  test.each([
    // A ruling point that rules on its legal basis is the ruling.
    "na podstawie art. 4 ust. 2 ustawy o Trybunale Konstytucyjnym umorzyć postępowanie",
    "po rozpoznaniu apelacji oddala ją",
    "1. zasądza od pozwanego kwotę 100 zł",
  ])("rules: %s", (text) => {
    expect(isPlRecitalLine(text)).toBe(false);
  });

  test("a ruling point that opens on its object still rules", () => {
    expect(containsPlOperativeVerb("I. powództwo oddala,")).toBe(true);
    expect(containsPlOperativeVerb("o d d a l a apelację")).toBe(true);
    expect(containsPlOperativeVerb("sprawy z powództwa M. D.")).toBe(false);
    expect(containsPlOperativeVerb("o oddaleniu powództwa")).toBe(false);
  });

  test("a spaced holding heading is the heading", () => {
    expect(isPlHoldingHeading("p o s t a n a w i a")).toBe(true);
    expect(isPlHoldingHeading("o r z e k a :")).toBe(true);
    expect(startsWithPlOperativeVerb("o d d a l a apelację")).toBe(true);
  });
});

describe("the opening of a Polish ruling", () => {
  test.each([
    "postanawia:",
    "1. zasądza od pozwanego kwotę 100 zł",
    "I.zmienia zaskarżoną decyzję",
    "oddala apelację",
    "o r z e k a :",
  ])("opens a ruling: %s", (text) => {
    expect(opensPlRuling(text)).toBe(true);
  });

  test.each([
    "I. powództwo oddala,",
    "po rozpoznaniu sprawy z powództwa M. D.",
    "1. Sąd zważył, co następuje",
  ])("does not open one on its verb: %s", (text) => {
    expect(opensPlRuling(text)).toBe(false);
  });

  test("an authority rules in the sentence naming its legal basis", () => {
    expect(
      isPlLegalBasisRuling(
        "Na podstawie art. 14b § 1 Ordynacji podatkowej Dyrektor Izby Skarbowej stwierdza, że stanowisko jest nieprawidłowe.",
      ),
    ).toBe(true);
    expect(isPlLegalBasisRuling("na podstawie art. 437 § 2 kpk")).toBe(false);
    expect(isPlLegalBasisRuling("1. zasądza na podstawie art. 98 k.p.c.")).toBe(
      false,
    );
  });

  test("the bench opens in either wording", () => {
    expect(isPlCompositionLine("w składzie:")).toBe(true);
    expect(
      isPlCompositionLine(
        "Sąd Okręgowy w Szczecinie Wydział VIII Gospodarczy w składzie następującym:",
      ),
    ).toBe(true);
    expect(isPlCompositionLine("w składzie orzekającym zasiadał")).toBe(false);
  });

  test("a document's title names its declared type", () => {
    expect(
      namesPlDocumentType(
        " INTERPRETACJA INDYWIDUALNA ",
        "interpretacja indywidualna",
      ),
    ).toBe(true);
    expect(
      namesPlDocumentType(
        "Zmiana interpretacji indywidualnej",
        "zmiana interpretacji indywidualnej",
      ),
    ).toBe(true);
    expect(
      namesPlDocumentType("INTERPRETACJA INDYWIDUALNA", "interpretacja ogólna"),
    ).toBe(false);
    expect(namesPlDocumentType("", "")).toBe(false);
  });
});
