import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  containsPlOperativeVerb,
  isPlAppealInstruction,
  isPlAuthorityDecisionTitle,
  isPlBenchMemberLine,
  isPlCompositionLine,
  isPlDecisionDateLine,
  isPlHoldingHeading,
  isPlInstructionHeading,
  isPlLegalBasisRuling,
  isPlReasonsHeading,
  isPlRecitalLine,
  isPlRemedyFilingLine,
  isPlSignatureBlank,
  isPlSignatureLine,
  namesPlDocumentType,
  opensPlRuling,
  plRulingClauseStart,
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

describe("a Polish instruction on appeal", () => {
  test.each([
    "Na orzeczenie - w terminie 14 dni od jego doręczenia - przysługuje skarga za pośrednictwem Prezesa Krajowej Izby Odwoławczej do Sądu Okręgowego w Warszawie.",
    "Stosownie do art. 198a i 198b ustawy z dnia 29 stycznia 2004 r. Prawo zamówień publicznych na niniejszy wyrok - w terminie 7 dni od dnia jego doręczenia - przysługuje skarga.",
    "Stosownie do treści art. 81 ust. 1 ustawy o ochronie konkurencji i konsumentów od niniejszej decyzji przysługuje stronie odwołanie do Sądu Okręgowego w Warszawie.",
    "Stronie przysługuje prawo do wniesienia skargi na niniejszą interpretację przepisów prawa podatkowego z powodu jej niezgodności z prawem.",
  ])("%p instructs on the remedy against this decision", (text) => {
    expect(isPlAppealInstruction(text)).toBe(true);
  });

  test.each([
    "Odwołującemu przysługuje prawo do skorzystania ze środka ochrony prawnej, gdyż wypełniono przesłankę interesu.",
    "Od decyzji organu pierwszej instancji przysługuje odwołanie, z którego strona skorzystała.",
    "Korekta kosztów wynagrodzenia pracowników przysługuje nam również w roku 2022.",
    "oddala skargę",
  ])("%p is not an instruction", (text) => {
    expect(isPlAppealInstruction(text)).toBe(false);
  });

  test("its heading and where the remedy is filed", () => {
    expect(isPlInstructionHeading("Pouczenie")).toBe(true);
    expect(isPlInstructionHeading("POUCZENIA:")).toBe(true);
    expect(isPlInstructionHeading("14. Pouczenie")).toBe(true);
    expect(isPlInstructionHeading("P o u c z e n i e")).toBe(true);
    expect(
      isPlInstructionHeading("Pouczenie o prawie do odwołania jest zbędne."),
    ).toBe(false);
    expect(
      isPlRemedyFilingLine("Skargę wnosi się za pośrednictwem organu."),
    ).toBe(true);
    expect(isPlRemedyFilingLine("Skarga została wniesiona w terminie.")).toBe(
      false,
    );
  });
});

describe("a Polish head-matter line", () => {
  test.each([
    "Przewodniczący: Ewa Sikorska",
    "Przewodnicząca: Agnieszka Trojanowska",
    "Protokolant: Aldona Karpińska",
    "Członkowie: Katarzyna Prowadzisz",
    "Protokolant: stażysta Anna Kosowska",
    "Przewodniczący: SSO Katarzyna Banko",
  ])("%p names who sat", (line) => {
    expect(isPlBenchMemberLine(line)).toBe(true);
  });

  test.each([
    "Przewodniczący:…………………………",
    "Przewodniczący:",
    "Skład orzekający Izby:",
    "Prokurator: zarzuty wobec oskarżonego",
    "Członkowie: zarzuty wobec członków zarządu",
  ])("%p is a signing label or a heading, not a name", (line) => {
    expect(isPlBenchMemberLine(line)).toBe(false);
  });

  test("the decision's date on a line of its own", () => {
    expect(isPlDecisionDateLine("z dnia 4 lutego 2022 r.")).toBe(true);
    expect(isPlDecisionDateLine("Warszawa, dnia 1 września 2025 roku")).toBe(
      true,
    );
    expect(isPlDecisionDateLine("Dnia 31 grudnia 2019 r.")).toBe(true);
    expect(isPlDecisionDateLine("z dnia 12.03.2021 r.")).toBe(true);
    expect(isPlDecisionDateLine("z dnia 4 lutego 2022 r.,")).toBe(true);
    expect(
      isPlDecisionDateLine(
        "po rozpoznaniu na rozprawie w dniu 1 lutego 2022 roku",
      ),
    ).toBe(false);
  });
});

describe("a Polish signature by title and name", () => {
  // Lines the recorded common-court decisions sign with.
  test.each([
    "Sędzia Przemysław Kociński",
    "ASR Maciej Skuczyński",
    "Sędzia SO Roman Troll (spr.)",
    "Sędzia Sądu Okręgowego Leszek Dąbek",
    "sędzia Barbara Pyz-Kędzierska",
    "asesor sądowy Aleksandra Zubowicz",
    "Przewodniczący - Sędzia SO Magdalena Balion - Hajduk",
    "Przewodniczący – SSR Tomasz Zieliński",
    "Przewodnicząca Sędzia SR A. S.",
    "SSR (del.) Sławomir Łabuz SSO Arkadia Wyraz – Wieczorek SSO Roman Troll",
    "SSA w SO Andrzej Szawel",
    "SSN Józef Dołhy (przewodniczący)",
    "Sędzia NSA Anna Nowak",
    "Referendarz sądowy Jan Kowalski",
    "Prezes Urzędu Ochrony Konkurencji i Konsumentów",
    "Sędzia sprawozdawca:",
  ])("signs: %p", (line) => {
    expect(isPlSignatureLine(line)).toBe(true);
  });

  test.each([
    // A sentence that opens on a title or office is the text, not a signature.
    "Prezes Urzędu ustalił następujący stan faktyczny:",
    "Prezes Urzędu ustalił, co następuje:",
    "Prezes Urzędu Ochrony Konkurencji i Konsumentów zważył, co następuje.",
    "Prezes Urzędu zakwestionował następujące postanowienia wzorca umowy zamówienie:",
    "Sędzia Jan Kowalski wskazał, że apelacja jest zasadna.",
    // Titles with no name, or a head-matter line naming the bench.
    "Sędzia NSA Sędzia NSA Sędzia NSA",
    "Sędzia Przewodniczący Sędzia",
    "Przewodniczący SSN Krystyna Bednarczyk (sprawozdawca), Sędziowie SN:",
    "Przewodniczący: Anna Kowalska",
    // A clerk signs no decision.
    "Starszy sekretarz sądowy Monika Nalewajk",
  ])("does not sign: %p", (line) => {
    expect(isPlSignatureLine(line)).toBe(false);
  });

  const TITLES = [
    "SSO",
    "SSA del.",
    "Sędzia",
    "Sędzia SR",
    "Sędzia Sądu Apelacyjnego",
    "ASR",
    "Asesor sądowy",
    "Referendarz sądowy",
    "Przewodnicząca Sędzia SO",
  ];
  const nameWord = fc
    .tuple(
      fc.constantFrom("A", "B", "Ć", "K", "Ł", "M", "Ż"),
      fc.stringMatching(/^[a-ząćęłńóśźż]{1,9}$/u),
    )
    .map(([initial, rest]) => `${initial}${rest}`);
  const name = fc.array(nameWord, { minLength: 1, maxLength: 3 });
  const verb = fc.constantFrom(
    "ustalił,",
    "zważył,",
    "wskazał",
    "zasądza",
    "oddala",
    "stwierdził,",
  );

  test("a title and a name and nothing else sign", () => {
    assertProperty(
      "a title and a name and nothing else sign",
      fc.property(fc.constantFrom(...TITLES), name, (title, words) =>
        isPlSignatureLine(`${title} ${words.join(" ")}`),
      ),
    );
  });

  test("a title and a name running on into a sentence sign nothing", () => {
    assertProperty(
      "a title and a name running on into a sentence sign nothing",
      fc.property(
        fc.constantFrom(...TITLES),
        name,
        verb,
        fc.array(
          fc.constantFrom("co", "następuje:", "że", "apelację", "kwotę"),
          {
            maxLength: 4,
          },
        ),
        (title, words, said, rest) =>
          !isPlSignatureLine([title, ...words, said, ...rest].join(" ")),
      ),
    );
  });
});

describe("a Polish authority's decision title", () => {
  test.each([
    "DECYZJA RGD - 1/2026",
    "DECYZJA DIH-1/48/2017",
    "DECYZJA NR RBG - 11/2018",
    "DECYZJA Nr RWA-26/2009",
    "DECYZJA nr RPZ 6/2011",
    "Decyzja nr 12",
  ])("%p is a decision title", (line) => {
    expect(isPlAuthorityDecisionTitle(line)).toBe(true);
  });

  test.each([
    "DECYZJA",
    "decyzja Prezesa Urzędu z dnia 3 marca 2020 r.",
    "Decyzja ta jest ostateczna.",
    "Decyzja nr 5 z dnia 3 marca 2020 r. została uchylona.",
    "Decyzja nr 5 z dnia 3 marca 2020",
    "Decyzja nr DOK-9/2011 jest prawomocna",
  ])("%p is not one", (line) => {
    expect(isPlAuthorityDecisionTitle(line)).toBe(false);
  });
});

describe("a Polish recital that rules in its last clause", () => {
  test("the ruling starts at its verb", () => {
    const text =
      "po przeprowadzeniu postępowania przeciwko spółce z siedzibą w Warszawie, uznaje się, że działanie narusza interesy konsumentów";
    const start = plRulingClauseStart(text);
    expect(start === undefined ? undefined : text.slice(start)).toStartWith(
      "uznaje się, że działanie",
    );
  });

  test("a recital without a ruling, or a ruling without a recital, is not split", () => {
    expect(
      plRulingClauseStart(
        "po rozpoznaniu na rozprawie w dniu 1 lutego 2022 roku w Warszawie odwołania",
      ),
    ).toBeUndefined();
    expect(plRulingClauseStart("Sąd, oddala apelację")).toBeUndefined();
  });
});
