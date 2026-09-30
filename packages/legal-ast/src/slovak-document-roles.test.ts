import { describe, expect, test } from "bun:test";

import { skSectionHeading } from "./slovak-document-roles";

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
      expect(skSectionHeading(`${numeral}.`)).toEqual({ level: 3 });
      expect(skSectionHeading(` ${numeral}. Ústavná sťažnosť `)).toEqual({
        level: 3,
      });
      expect(skSectionHeading(`${numeral}. A) Argumentácia`)).toEqual({
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
      expect(skSectionHeading(text)).toBeNull();
    }
  });
});
