import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { extractCourtParagraphNumbers } from "./court-paragraph-numbers.js";
import type { Block, ParagraphBlock } from "./document-ast.js";
import {
  opensWithDate,
  opensWithItemLabel,
  PRINTED_LABEL_KIND,
  printedLabelOpensParagraph,
  readPrintedLabel,
} from "./printed-paragraph-labels.js";

describe("readPrintedLabel", () => {
  test.each([
    ["12. Soud", PRINTED_LABEL_KIND.NUMBER, "12."],
    ["3) Stěžovatel", PRINTED_LABEL_KIND.NUMBER, "3)"],
    ["[12] Soud", PRINTED_LABEL_KIND.BRACKET, "[12]"],
    ["5.5. Dovolanie prípustné", PRINTED_LABEL_KIND.SUBNUMBER, "5.5."],
    ["16.1. Dovolací súd", PRINTED_LABEL_KIND.SUBNUMBER, "16.1."],
    ["(2) Dovolací dôvod", PRINTED_LABEL_KIND.PARENTHESISED, "(2)"],
    ["a) sa rozhodlo", PRINTED_LABEL_KIND.LETTER, "a)"],
    ["IV. Posouzení", PRINTED_LABEL_KIND.ROMAN, "IV."],
    ["IX. Záver", PRINTED_LABEL_KIND.ROMAN, "IX."],
    ["X. Náklady konania", PRINTED_LABEL_KIND.ROMAN, "X."],
    ["XI. Poučenie", PRINTED_LABEL_KIND.ROMAN, "XI."],
    ["[2]Súd prvej inštancie", PRINTED_LABEL_KIND.BRACKET, "[2]"],
    ["- súd prvého stupňa", PRINTED_LABEL_KIND.BULLET, "-"],
  ])("%s opens with a %s label", (line, kind, marker) => {
    expect(readPrintedLabel(line)).toMatchObject({ kind, marker });
  });

  test.each([
    "II. ÚS 177/04",
    "IV. senátu Ústavného súdu",
    "28.5.2014 doručil",
    "1.2. 1999",
    "1 014,41 eur",
    "Súd prvej inštancie",
  ])("%s opens with no label", (line) => {
    expect(readPrintedLabel(line)).toBeNull();
  });

  test("a sub-paragraph is an item the court numbering leaves out", () => {
    expect(opensWithItemLabel("5.5. Dovolanie")).toBe(true);
    expect(opensWithItemLabel("Dovolanie 5.5.")).toBe(false);
  });
});

describe("dates", () => {
  test.each([
    "2. júla 2014, pričom žalobca",
    "12. mája 2021 č. k. 9Co/80/2020-234",
    "11. února 2015 podal",
    "29. 4. 2016 rozhodl",
    "5. maja 2020 r.",
  ])("%s opens with a date", (line) => {
    expect(opensWithDate(line)).toBe(true);
  });

  test("a numbered point with a lowercase word is no date", () => {
    expect(opensWithDate("2. osoby, które")).toBe(false);
  });
});

describe("printedLabelOpensParagraph", () => {
  test.each([
    // A date wrapped after its day continues the sentence.
    ["Rozsudok nadobudol právoplatnosť dňa", "2. júla 2014, pričom", true],
    ["Krajského súdu v Košiciach z", "12. mája 2021 č. k. 9Co", true],
    ["rozhodnutím ze dne", "29. 4. 2016 zamítl", false],
    // A citation wrapped after the word its number belongs to.
    ["podle § 2 písm.", "b) uvedeného dekretu", false],
    ["zgodnie z art.", "5 ust. 2", false],
    ["v bode", "5.5. tohto rozhodnutia", true],
    // A dash after a full line that closes nothing goes on a name.
    ["sídlem v Praze 5", "- Stodůlky, Jeremiášova 1", true],
  ])("%s / %s continues", (above, line, aboveFilled) => {
    expect(printedLabelOpensParagraph({ above, line, aboveFilled })).toBe(
      false,
    );
  });

  test.each([
    [
      "dovolacím súdom rozhodovaná rozdielne.",
      "5.5. Dovolanie prípustné",
      true,
    ],
    ["inú, pre ňu vhodnú prácu.", "1.2. Súd prvej inštancie", false],
    ["trovy konania vo výške 100 eur", "2. žalobcovi sa priznáva", true],
    ["- rozhodoval vylúčený sudca,", "- súd prvého stupňa", true],
    ["rozhodol takto:", "I. Dovolanie zamieta.", true],
    ["Odôvodnenie", "1. Okresný súd", false],
    [undefined, "1. Okresný súd", undefined],
  ])("%s / %s opens a paragraph", (above, line, aboveFilled) => {
    expect(printedLabelOpensParagraph({ above, line, aboveFilled })).toBe(true);
  });

  test("only a label opens a paragraph", () => {
    assertProperty(
      "only a label opens a paragraph",
      fc.property(
        fc.string(),
        fc.stringMatching(/^[\p{Ll}\p{Lu} ,]{1,20}$/u),
        (above, line) => {
          fc.pre(readPrintedLabel(line) === null);
          expect(printedLabelOpensParagraph({ above, line })).toBe(false);
        },
      ),
    );
  });

  test("a label after a finished sentence opens a paragraph, however full the line", () => {
    assertProperty(
      "a label after a finished sentence opens a paragraph, however full the line",
      fc.property(
        fc.constantFrom("12.", "[3]", "5.5.", "(2)", "a)", "IV."),
        fc.constantFrom("Soud zamítl.", "rozhodol takto:", "§ 420 CSP;"),
        fc.boolean(),
        (marker, above, aboveFilled) => {
          expect(
            printedLabelOpensParagraph({
              above,
              line: `${marker} Dovolací súd`,
              aboveFilled,
            }),
          ).toBe(true);
        },
      ),
    );
  });
});

describe("numbering restarts per separate opinion", () => {
  let id = 0;
  const paragraph = (
    text: string,
    role?: ParagraphBlock["role"],
  ): ParagraphBlock => {
    id += 1;
    return {
      id: `b${String(id)}`,
      anchorId: `p-${String(id)}`,
      type: "paragraph",
      ...(role === undefined ? {} : { role }),
      inlines: [{ type: "text", text }],
      plainText: text,
    };
  };
  const heading = (text: string): Block => {
    id += 1;
    return {
      id: `b${String(id)}`,
      anchorId: `h-${String(id)}`,
      type: "heading",
      level: 2,
      inlines: [{ type: "text", text }],
      plainText: text,
    };
  };
  const run = (count: number, role?: ParagraphBlock["role"]) =>
    Array.from({ length: count }, (_, index) =>
      paragraph(`[${String(index + 1)}] Soud uvážil věc.`, role),
    );

  test("a decision's [1]..[20] and two opinions' [1]..[13] and [1]..[8] each keep their numbers", () => {
    const blocks = [
      ...run(20),
      heading("Odlišné stanovisko soudce Karla Šimky"),
      ...run(13, "dissent"),
      heading("Odlišné stanovisko soudce Jiřího Pally"),
      ...run(8, "dissent"),
    ];
    const numbering = extractCourtParagraphNumbers(blocks);
    expect(numbering.type).toBe("numbered");
    expect(
      numbering.blocks.flatMap((block) =>
        block.type === "paragraph" && block.number !== undefined
          ? [block.number]
          : [],
      ),
    ).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index + 1),
      ...Array.from({ length: 13 }, (_, index) => index + 1),
      ...Array.from({ length: 8 }, (_, index) => index + 1),
    ]);
    expect(
      numbering.blocks.some(
        (block) =>
          block.type === "paragraph" && block.plainText.startsWith("["),
      ),
    ).toBe(false);
  });

  test("sub-paragraphs between numbered paragraphs leave the numbering standing", () => {
    const blocks = [
      paragraph("1. Okresný súd rozhodol."),
      paragraph("1.1. Súd prvej inštancie vykonal dokazovanie."),
      paragraph("1.2. O trovách rozhodol podľa úspechu."),
      paragraph("1.3. Žalobkyňa podala odvolanie."),
      paragraph("2. Krajský súd rozsudok potvrdil."),
      paragraph("2.1. Odvolací súd sa stotožnil."),
      paragraph("2.2. Dovolateľ namietal."),
      paragraph("3. Dovolanie je prípustné."),
    ];
    const numbering = extractCourtParagraphNumbers(blocks);
    expect(
      numbering.blocks.flatMap((block) =>
        block.type === "paragraph" ? [block.number ?? null] : [],
      ),
    ).toEqual([1, null, null, null, 2, null, null, 3]);
  });
});
