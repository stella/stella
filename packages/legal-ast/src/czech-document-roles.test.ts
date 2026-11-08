import { describe, expect, test } from "bun:test";

import {
  CZ_TAKTO_TAIL_RE,
  czechAuthorityHeadRoles,
  isCzechAuthorityDecisionTitle,
  isCzechAuthoritySignatureLine,
  isCzechBareSignatoryName,
  isCzechCopyCertification,
  isCzechInstructionHeading,
  isCzechOpeningFormula,
  isCzechReasonsHeading,
  isCzechRulingLeadIn,
  isCzechSignatoryName,
  isCzechSignatureLine,
  isCzechTaktoLine,
  isCzechVerdictFormulaLine,
  normalizeCzechJudgeName,
  withInferredCzechSignatureRoles,
} from "./czech-document-roles";
import type { Block } from "./document-ast";

const inlineText = (text: string) => [{ type: "text" as const, text }];

const paragraph = (id: string, plainText: string): Block => ({
  anchorId: id,
  id,
  inlines: inlineText(plainText),
  plainText,
  type: "paragraph",
});

const heading = (id: string, plainText: string): Block => ({
  anchorId: id,
  id,
  inlines: inlineText(plainText),
  level: 1,
  plainText,
  type: "heading",
});

describe("Czech legal-document signatures", () => {
  test("one signature role covers courts and other public authorities", () => {
    const refined = withInferredCzechSignatureRoles([
      paragraph("body", "Toto opatření nabývá účinnosti dnem vyhlášení."),
      heading("office-1", "Guvernér:"),
      heading("name", "v z. prof. Dr. Ing. Frait v. r."),
      heading("office-2", "viceguvernér"),
      paragraph("judge", "předseda senátu"),
    ]);

    expect(refined.at(0)).toEqual(
      paragraph("body", "Toto opatření nabývá účinnosti dnem vyhlášení."),
    );
    for (const block of refined.slice(1)) {
      expect(block.type).toBe("paragraph");
      expect(block.type === "paragraph" ? block.role : null).toBe("signature");
    }
  });
});

describe("the office a Czech judge signs under", () => {
  test.each([
    "předseda senátu",
    "předsedkyně senátu:",
    "místopředseda senátu",
    "předseda rozšířeného senátu",
    "člen rozšířeného senátu",
    "členka rozšířeného senátu",
    "předseda velkého senátu",
    "předseda Ústavního soudu",
    "předsedkyně Nejvyššího správního soudu",
    "JUDr. Jan Novák v. r.",
  ])("%j signs", (text) => {
    expect(isCzechSignatureLine(text)).toBe(true);
  });

  test.each([
    // Declined forms belong to running text, never to a signature.
    "rozhodl v senátě složeném z předsedy rozšířeného senátu",
    "předsedy Ústavního soudu",
    "člena rozšířeného senátu",
    "Ve vyjádření k ústavní stížnosti, které podal jako účastník řízení Krajský soud v Brně a které podepsal předseda senátu, se uvádí",
    "předseda Krajského soudu",
  ])("%j does not sign", (text) => {
    expect(isCzechSignatureLine(text)).toBe(false);
  });

  test("a bare name signs only as a name", () => {
    expect(isCzechBareSignatoryName("Josef Baxa")).toBe(true);
    expect(isCzechBareSignatoryName("Petra Svobodová-Dvořáková")).toBe(true);
    expect(isCzechBareSignatoryName("Josef")).toBe(false);
    expect(isCzechBareSignatoryName("Kasační stížnost se zamítá.")).toBe(false);
  });

  test.each([
    "JUDr. Miluše Došková",
    "Mgr. Miroslav Hromada, Ph.D.",
    "JUDr. František B a l á k, v.r.",
    "doc. JUDr. Jan Novák, CSc.",
    "Dr. Jan Novák",
    "Mgr. Petra Svobodová, MSc.",
    "Josef Baxa",
  ])("%p signs as a name with its degrees", (line) => {
    expect(isCzechSignatoryName(line)).toBe(true);
  });

  test.each([
    "JUDr.",
    "předseda senátu",
    "Za správnost vyhotovení: Ivana Svobodová",
    "Mgr. Novák zastoupený advokátem",
  ])("%p is not a signed name", (line) => {
    expect(isCzechSignatoryName(line)).toBe(false);
  });

  test("the certification of a copy is the office's, letter-spaced or not", () => {
    expect(
      isCzechCopyCertification("Za správnost vyhotovení: Ivana Svobodová"),
    ).toBe(true);
    expect(isCzechCopyCertification("Za správnost vyhotovení:")).toBe(true);
    // Decomposed letters and a no-break space read the same.
    expect(
      isCzechCopyCertification("Za\u00a0spra\u0301vnost vyhotovení:"),
    ).toBe(true);
    expect(
      isCzechCopyCertification("Z a  s p r á v n o s t  vyhotovení:"),
    ).toBe(true);
    expect(
      isCzechCopyCertification("Za správnost výpočtu odpovídá žalobce."),
    ).toBe(false);
  });
});

describe("the Czech reasons heading", () => {
  test.each(["Odůvodnění:", "ODŮVODNĚNÍ", "O d ů v o d n ě n í :"])(
    "%j opens the reasons",
    (text) => {
      expect(isCzechReasonsHeading(text)).toBe(true);
    },
  );

  test.each(["V odůvodnění rozsudku", "Odůvodnění rozhodnutí je stručné."])(
    "%j does not",
    (text) => {
      expect(isCzechReasonsHeading(text)).toBe(false);
    },
  );
});

describe("opening formula and lead-in", () => {
  test.each([
    "JMÉNEM REPUBLIKY",
    "Jménem republiky",
    "J M É N E M   R E P U B L I K Y",
    "ČESKÁ REPUBLIKA",
  ])("%j is the formula", (text) => {
    expect(isCzechOpeningFormula(text)).toBe(true);
  });

  test.each(["ROZSUDEK", "Jménem republiky rozhodl soud", ""])(
    "%j is not the formula",
    (text) => {
      expect(isCzechOpeningFormula(text)).toBe(false);
    },
  );

  test("reads takto: through its spacing", () => {
    for (const text of ["takto:", "takto", "t a k t o :", "Takto:"]) {
      expect(isCzechTaktoLine(text)).toBe(true);
    }
    expect(isCzechTaktoLine("Soud rozhodl takto:")).toBe(false);
    expect(CZ_TAKTO_TAIL_RE.test("Soud rozhodl takto:")).toBe(true);
  });
});

describe("judge name", () => {
  test.each([
    ["JUDr. Zdeněk     Krčmář,v.r.", "JUDr. Zdeněk Krčmář"],
    ["JUDr. Zdeněk Krčmář, v. r.", "JUDr. Zdeněk Krčmář"],
    ["JUDr.  Pavel   Simon", "JUDr. Pavel Simon"],
    ["doc. JUDr. Jan Novák", "doc. JUDr. Jan Novák"],
    ["JUDr. František I š t v á n e k, v. r.", "JUDr. František Ištvánek"],
    ["JUDr. Pavel  P a v l í k, v. r.", "JUDr. Pavel Pavlík"],
    ["JUDr. P a v e l   P a v l í k", "JUDr. Pavel Pavlík"],
    ["JUDr. P a v e l\nP a v l í k", "JUDr. Pavel Pavlík"],
    ["JUDr. P a v e l\tP a v l í k, v. r.", "JUDr. Pavel Pavlík"],
    ["Mgr. Jan Novák, v. r.", "Mgr. Jan Novák"],
  ])("%j is %j", (printed, name) => {
    expect(normalizeCzechJudgeName(printed)).toBe(name);
  });

  test.each([
    "JUDr. Zdeněk     Krčmář,v.r.",
    "JUDr. František I š t v á n e k, v. r.",
    "JUDr. P a v e l   P a v l í k",
  ])("is idempotent on %j", (printed) => {
    const once = normalizeCzechJudgeName(printed);
    expect(normalizeCzechJudgeName(once)).toBe(once);
  });

  test("keeps no letter-spaced run in the name", () => {
    for (const printed of [
      "JUDr. František I š t v á n e k, v. r.",
      "JUDr. Pavel  P a v l í k, v. r.",
      "doc. JUDr. R o m a n   F i a l a , v. r.",
    ]) {
      expect(normalizeCzechJudgeName(printed)).not.toMatch(
        /(?:^|\s)\p{L}(?: \p{L}){3,}(?=\s|,|$)/u,
      );
    }
  });
});

describe("an authority's decision up to its reasons", () => {
  test.each([
    "rozhodl takto:",
    "… ve znění pozdějších předpisů, rozhodl takto:",
    "r o z h o d l   t a k t o :",
    "ROZHODNUTÍ:",
    "rozhodla:",
  ])("%j leads in to the operative part", (text) => {
    expect(isCzechRulingLeadIn(text)).toBe(true);
  });

  test.each(["ROZHODNUTÍ", "Úřad rozhodl o rozkladu.", "rozhodnutí: viz výše"])(
    "%j does not",
    (text) => {
      expect(isCzechRulingLeadIn(text)).toBe(false);
    },
  );

  test("the head matter, the operative part, then nothing from the reasons on", () => {
    expect(
      czechAuthorityHeadRoles([
        "ROZHODNUTÍ",
        "V řízení o rozkladu … na návrh rozkladové komise",
        "rozhodl takto:",
        "Napadené rozhodnutí potvrzuji a rozklad zamítám.",
        "ODŮVODNĚNÍ",
        "1. Úřad vydal rozhodnutí.",
      ]),
    ).toEqual(["intro", "intro", "intro", "holding", undefined, undefined]);
    // Without a lead-in or a reasons heading the caller keeps its reading.
    expect(
      czechAuthorityHeadRoles(["ROZHODNUTÍ", "ODŮVODNĚNÍ"]),
    ).toBeUndefined();
    expect(czechAuthorityHeadRoles(["rozhodl takto:", "I."])).toBeUndefined();
  });

  test.each([
    "Ing. Petr Rafaj předseda Úřadu pro ochranu hospodářské soutěže",
    "I. místopředseda Úřadu",
    "Mgr. Markéta Dlouhá místopředsedkyně",
  ])("%j signs under the office", (text) => {
    expect(isCzechAuthoritySignatureLine(text)).toBe(true);
  });

  test.each([
    "Rozklad podaný proti rozhodnutí posoudil předseda Úřadu a dospěl k závěru, že je nedůvodný.",
    "předsedy Úřadu",
  ])("%j does not", (text) => {
    expect(isCzechAuthoritySignatureLine(text)).toBe(false);
  });
});

describe("an authority's decision headings", () => {
  test("the title and the instruction read through their spacing", () => {
    expect(isCzechAuthorityDecisionTitle("ROZHODNUTÍ")).toBe(true);
    expect(
      isCzechAuthorityDecisionTitle(
        "ROZHODNUTÍ PŘEDSEDY ÚŘADU PRO OCHRANU HOSPODÁŘSKÉ SOUTĚŽE",
      ),
    ).toBe(true);
    expect(isCzechAuthorityDecisionTitle("ROZHODNUTÍ:")).toBe(false);
    expect(isCzechAuthorityDecisionTitle("Rozhodnutí Úřadu potvrzuji.")).toBe(
      false,
    );
    expect(isCzechInstructionHeading("POUČENÍ")).toBe(true);
    expect(isCzechInstructionHeading("P o u č e n í :")).toBe(true);
    expect(isCzechInstructionHeading("Poučení: Proti rozhodnutí")).toBe(false);
  });
});

describe("a Czech criminal verdict's formula lines", () => {
  test.each([
    "je vinen, že",
    "čímž spáchal",
    "tím spáchala",
    "a odsuzuje se",
    "přičemž",
    "tedy",
  ])("%p is a formula line", (line) => {
    expect(isCzechVerdictFormulaLine(line)).toBe(true);
  });

  test.each(["Tedyho návrh", "Soud dospěl k závěru, že", "jeho vina"])(
    "%p is not",
    (line) => {
      expect(isCzechVerdictFormulaLine(line)).toBe(false);
    },
  );
});
