import { describe, expect, test } from "bun:test";

import type { TemplateNumberingLevel } from "@/api/lib/templates/house-style/folio-contract";
import {
  REFERENCE_FIELD_SWITCHES,
  selectReferenceField,
} from "@/api/lib/templates/house-style/reference-fields";

const { number, numberWithoutWords } = REFERENCE_FIELD_SWITCHES;

/** A contract template's list: `Článek 1`, `1.1.`, `1.1.1.`, `a)`, `(i)`. */
const LEVELS = [
  { ilvl: 0, numFmt: "decimal", lvlText: "Článek %1" },
  { ilvl: 1, numFmt: "decimal", lvlText: "%1.%2." },
  { ilvl: 2, numFmt: "decimal", lvlText: "%1.%2.%3." },
  { ilvl: 3, numFmt: "lowerLetter", lvlText: "%4)" },
  { ilvl: 4, numFmt: "lowerRoman", lvlText: "(%5)" },
] as const satisfies readonly TemplateNumberingLevel[];

describe("selectReferenceField keeping the source's numbering", () => {
  test.each([
    // source label, patched level text, designator in the text, switches
    ["Článek XI.", "Článek %1.", "XI", numberWithoutWords],
    ["§ 5", "§ %1", "5", numberWithoutWords],
    ["Annex 2", "Annex %1", "2", numberWithoutWords],
    ["XI.", "%1.", "XI", number],
    ["2.", "%2.", "2", number],
    ["5.1.", "%1.%2.", "5.1", number],
    ["5.1.2", "%1.%2.%3", "5.1.2", number],
    ["d)", "%4)", "d)", number],
    ["(ii)", "(%5)", "(ii)", number],
    ["(b)", "(%4)", "(b)", number],
  ] as const)("%s", (sourceLabel, levelText, designatorText, instruction) => {
    const field = selectReferenceField({
      designatorText,
      levelText,
      numbering: { mode: "keepSource", sourceLabel },
    });
    expect(field.unwrap()).toEqual({
      instruction,
      expectedText: designatorText,
      text: "kept",
    });
  });

  test.each([
    // The text says `d`, the label prints `d)`: the field would add a bracket.
    ["d)", "%4)", "d"],
    // The text says `11`, the heading prints `XI`.
    ["Článek XI.", "Článek %1.", "11"],
    // A relative `odst. 1` under a label that prints the article too.
    ["5.1.", "%1.%2.", "1"],
    // The paragraph is labelled `(1)`; the text says `1`.
    ["(1)", "(%2)", "1"],
  ] as const)(
    "refuses %s for the designator %s",
    (sourceLabel, levelText, designatorText) => {
      const field = selectReferenceField({
        designatorText,
        levelText,
        numbering: { mode: "keepSource", sourceLabel },
      });
      expect(field.isErr() && field.error.reason).toBe("designator-mismatch");
    },
  );

  // The field drops the words of a level text and keeps their punctuation:
  // `Příloha č. 2` would show `.2`, not `2`.
  test.each([
    ["Čl. 5", "Čl. %1", "5"],
    ["Příloha č. 2", "Příloha č. %1", "2"],
    ["Art. 3", "Art. %1", "3"],
    ["Článek (3)", "Článek (%1)", "(3)"],
    ["Schedule No. 4", "Schedule No. %1", "4"],
  ] as const)(
    "refuses %s, whose words carry punctuation",
    (sourceLabel, levelText, designatorText) => {
      const field = selectReferenceField({
        designatorText,
        levelText,
        numbering: { mode: "keepSource", sourceLabel },
      });
      expect(field.isErr() && field.error.reason).toBe("punctuated-words");
    },
  );

  test("refuses a label that is not a designator", () => {
    const field = selectReferenceField({
      designatorText: "1",
      levelText: "%1.",
      numbering: { mode: "keepSource", sourceLabel: "•" },
    });
    expect(field.isErr() && field.error.reason).toBe("unreadable-label");
  });
});

describe("selectReferenceField in the template's scheme", () => {
  test.each([
    // level, counters, designator in the text, switches, result, text
    [0, [5], "5", numberWithoutWords, "5", "kept"],
    [0, [11], "XI", numberWithoutWords, "11", "renumbered"],
    [1, [5, 1], "5.1", number, "5.1", "kept"],
    [1, [11, 2], "2", number, "11.2", "renumbered"],
    [2, [5, 1, 2], "5.1.2", number, "5.1.2", "kept"],
    [3, [11, 2, 0, 4], "d)", number, "d)", "kept"],
    [4, [11, 2, 0, 4, 2], "(ii)", number, "(ii)", "kept"],
  ] as const)(
    "level %d with counters %j",
    (ilvl, counters, designatorText, instruction, expectedText, text) => {
      const field = selectReferenceField({
        designatorText,
        levelText: LEVELS[ilvl].lvlText,
        numbering: { mode: "houseScheme", levels: LEVELS, counters },
      });
      expect(field.unwrap()).toEqual({ instruction, expectedText, text });
    },
  );

  test("words are dropped whatever the level text puts around the counter", () => {
    const levels = [
      { ilvl: 0, numFmt: "upperRoman", lvlText: "Článek %1." },
      { ilvl: 1, numFmt: "decimal", lvlText: "%2." },
    ] as const satisfies readonly TemplateNumberingLevel[];
    const read = (levelText: string, counters: number[]) =>
      selectReferenceField({
        designatorText: "",
        levelText,
        numbering: { mode: "houseScheme", levels, counters },
      }).unwrap();
    expect(read("Článek %1.", [11])).toMatchObject({
      instruction: numberWithoutWords,
      expectedText: "XI",
    });
    expect(read("%2.", [11, 2])).toMatchObject({
      instruction: number,
      expectedText: "2",
    });
    expect(read("§ %1", [11])).toMatchObject({
      instruction: numberWithoutWords,
      expectedText: "XI",
    });
    // What follows the counter without a word keeps its punctuation and
    // loses its blanks.
    expect(read("Part %1 -", [11])).toMatchObject({
      instruction: numberWithoutWords,
      expectedText: "XI-",
    });
    expect(read("Annex %1:", [11])).toMatchObject({
      instruction: numberWithoutWords,
      expectedText: "XI:",
    });
  });

  test("refuses a level whose words stand beside a bracket", () => {
    const field = selectReferenceField({
      designatorText: "(XI)",
      levelText: "Článek (%1)",
      numbering: {
        mode: "houseScheme",
        levels: [{ ilvl: 0, numFmt: "upperRoman", lvlText: "Článek (%1)" }],
        counters: [11],
      },
    });
    expect(field.isErr() && field.error.reason).toBe("punctuated-words");
  });

  test("refuses a level whose words carry punctuation", () => {
    const levels = [
      { ilvl: 0, numFmt: "decimal", lvlText: "Čl. %1" },
    ] as const satisfies readonly TemplateNumberingLevel[];
    const field = selectReferenceField({
      designatorText: "5",
      levelText: "Čl. %1",
      numbering: { mode: "houseScheme", levels, counters: [5] },
    });
    expect(field.isErr() && field.error.reason).toBe("punctuated-words");
  });

  test("refuses a level it cannot render", () => {
    const reasonOf = (levelText: string, counters: number[]) => {
      const field = selectReferenceField({
        designatorText: "1",
        levelText,
        numbering: {
          mode: "houseScheme",
          levels: [{ ilvl: 0, numFmt: "bullet", lvlText: "•" }],
          counters,
        },
      });
      return field.isErr() ? field.error.reason : null;
    };
    expect(reasonOf("%1.", [1])).toBe("unrenderable-level");
    expect(reasonOf("%2.", [1])).toBe("unrenderable-level");
    expect(reasonOf("•", [1])).toBe("unrenderable-level");
  });
});
