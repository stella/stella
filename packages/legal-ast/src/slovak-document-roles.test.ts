import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { collapseSpacedLetters } from "@stll/text-normalize";

import { isSkHoldingMarker, skSectionHeading } from "./slovak-document-roles";

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

describe("Slovak holding marker suffixes", () => {
  test("retains case, spacing, punctuation and literal suffix rules", () => {
    for (const text of [
      "rozhodol:",
      "JUDr. Čapek rozhodol:",
      "O Novákovej rozhodla:",
      "ROZHODLO:",
      "r o z h o d o l :",
      "rozh od ol :",
      "😀rozhodla:\u00a0",
      "rozhodol:rozhodla:",
      "\ud800rozhodol:",
      "\ufffdrozhodol:",
    ]) {
      expect(isSkHoldingMarker(text)).toBe(true);
    }
    for (const text of [
      "",
      "rozhódol:",
      "rozhodol",
      "rozhodol：",
      "rozhodol: citácia",
      "rozhodla:.",
      "Rozhodnutie o Čapkovi",
    ]) {
      expect(isSkHoldingMarker(text)).toBe(false);
    }
  });

  test("caps the trimmed printed line in UTF-16 units before removing internal spacing", () => {
    expect(isSkHoldingMarker(`${"x".repeat(31)}rozhodol:`)).toBe(true);
    expect(isSkHoldingMarker(`${"x".repeat(32)}rozhodol:`)).toBe(false);
    expect(isSkHoldingMarker(`  ${"😀".repeat(15)}xrozhodol:  `)).toBe(true);
    expect(isSkHoldingMarker(`${"😀".repeat(16)}rozhodol:`)).toBe(false);
    expect(isSkHoldingMarker(`r${" ".repeat(35)}ozhodol:`)).toBe(false);
  });

  test("Slovak holding marker matching preserves normalized suffix semantics", () => {
    const line = fc
      .tuple(
        fc.array(fc.constantFrom("x", "Č", "á", "😀", " ", "\t", ":"), {
          maxLength: 45,
        }),
        fc.constantFrom(
          "rozhodol:",
          "ROZHODLA:",
          "r o z h o d l o :",
          "rozhódol:",
          "",
        ),
        fc.constantFrom("", " ", ".", " ďalšie"),
      )
      .map(
        ([prefix, marker, suffix]) => `${prefix.join("")}${marker}${suffix}`,
      );
    assertProperty(
      "Slovak holding marker matching preserves normalized suffix semantics",
      fc.property(line, (text) => {
        const normalized = collapseSpacedLetters(text.toLowerCase()).replaceAll(
          /\s+/gu,
          "",
        );
        const expected =
          text.trim().length <= 40 &&
          ["rozhodol:", "rozhodla:", "rozhodlo:"].some((marker) =>
            normalized.endsWith(marker),
          );
        expect(isSkHoldingMarker(text)).toBe(expected);
      }),
    );
  });
});
