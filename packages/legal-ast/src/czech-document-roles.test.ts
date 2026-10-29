import { describe, expect, test } from "bun:test";

import {
  CZ_TAKTO_TAIL_RE,
  isCzechOpeningFormula,
  isCzechTaktoLine,
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
  ])("%j is %j", (printed, name) => {
    expect(normalizeCzechJudgeName(printed)).toBe(name);
  });

  test("is idempotent", () => {
    const once = normalizeCzechJudgeName("JUDr. Zdeněk     Krčmář,v.r.");
    expect(normalizeCzechJudgeName(once)).toBe(once);
  });
});
