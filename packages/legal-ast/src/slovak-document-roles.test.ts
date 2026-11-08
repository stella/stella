import { describe, expect, test } from "bun:test";

import {
  isSkOpeningFormula,
  skSectionHeading,
  skTitleFormulaStart,
} from "./slovak-document-roles";

describe("Slovak Roman section headings", () => {
  test("dividers and titled sections share outline levels", () => {
    for (const numeral of [
      "I",
      "II",
      "III",
      "IV",
      "V",
      "VI",
      "VII",
      "VIII",
      "IX",
      "X",
      "XI",
      "XII",
    ]) {
      expect(skSectionHeading(`${numeral}.`, "reasoning")).toEqual({
        level: 3,
      });
      expect(
        skSectionHeading(` ${numeral}. Ústavná sťažnosť `, "reasoning"),
      ).toEqual({
        level: 3,
      });
      expect(
        skSectionHeading(`${numeral}. A) Argumentácia`, "reasoning"),
      ).toEqual({
        level: 4,
      });
    }
  });

  test("docket citations and numbered paragraphs stay prose", () => {
    for (const text of [
      "II. ÚS 177/04",
      "1. Argumentácia",
      `I. ${"text ".repeat(50)}`,
    ]) {
      expect(skSectionHeading(text, "reasoning")).toBeNull();
    }
  });
});

test("Roman titled items are prose outside reasoning while bare dividers remain structural", () => {
  const sections = ["preamble", "holding", "instruction", "closing"] as const;
  for (const section of sections) {
    expect(skSectionHeading("I. Súd žalobu zamieta.", section)).toBeNull();
    expect(skSectionHeading("I.", section)).toEqual({ level: 3 });
  }
});

describe("the Slovak opening formula", () => {
  test.each([
    "V MENE SLOVENSKEJ REPUBLIKY",
    "V  M E N E   S L O V E N S K E J   R E P U B L I K Y",
    "v mene republiky",
  ])("%j is the formula", (text) => {
    expect(isSkOpeningFormula(text)).toBe(true);
  });

  test("is read off a title it runs on from", () => {
    expect(skTitleFormulaStart("ROZSUDOK V MENE SLOVENSKEJ REPUBLIKY")).toBe(9);
    expect(
      skTitleFormulaStart("TRESTNÝ ROZKAZ  V MENE SLOVENSKEJ REPUBLIKY"),
    ).toBe(16);
    expect(skTitleFormulaStart("ROZSUDOK")).toBeUndefined();
    expect(skTitleFormulaStart("ROZSUDOK V MENE")).toBeUndefined();
    expect(
      skTitleFormulaStart("Súd rozhodol V MENE SLOVENSKEJ REPUBLIKY"),
    ).toBeUndefined();
  });
});
