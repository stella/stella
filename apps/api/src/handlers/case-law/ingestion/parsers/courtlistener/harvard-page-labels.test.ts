import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import { type Block, plainTextOf } from "@stll/legal-ast/document-ast";
import { propertyConfig } from "@stll/property-testing";

import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

import { conservesText } from "./blocks";
import { parseHarvardXml } from "./harvard-xml";
import { createTextBudget } from "./outcome";

const parse = (body: string) =>
  parseHarvardXml({
    text: `<opinion><p>${body}</p></opinion>`,
    prefix: "o1",
    rowType: "020lead",
    budget: createTextBudget(),
  });

describe("removed page labels preserve source word boundaries", () => {
  const boundaries = [
    ["inside a word", "coun", "sel"],
    ["after a hyphen", "obliga-", "tioa"],
    ["between spaced words", "the ", " court"],
    ["beside a newline", "the\n", "court"],
    ["beside a nonbreaking space", "the\u00a0", "court"],
  ] as const;
  const labels = [
    ["*12", ""],
    ["12", ""],
    ["* 12", ""],
    [" *12", " "],
    ["*12 ", " "],
    [" * 12 ", " "],
  ] as const;

  for (const [name, left, right] of boundaries) {
    for (const [label, separator] of labels) {
      test(`${name} with printed label ${JSON.stringify(label)}`, () => {
        const parsed = parse(
          `${left}<page-number label="12">${label}</page-number>${right}`,
        );
        expect(parsed.status).toBe("parsed");
        if (parsed.status !== "parsed") {
          return;
        }
        expect(cheerio.load(parsed.text.validationHtml)("p").text()).toBe(
          left + separator + right,
        );
        const allBlocks = parsed.text.units.flatMap(({ blocks }) => [
          ...blocks,
        ]);
        const astText = allBlocks
          .map((block) => {
            expect(block.type).toBe("paragraph");
            return block.type === "paragraph" ? plainTextOf(block.inlines) : "";
          })
          .join(" ");
        expect(astText.replace(/\s+/gu, " ").trim()).toBe(
          `${left}${separator}${right}`.replace(/\s+/gu, " ").trim(),
        );
        expect(
          validateAst(parsed.text.validationHtml, allBlocks).stats.missingWords,
        ).toEqual([]);
        expect(parsed.text.counts.paginationCharacters).toBe(
          label.replace(/\s/gu, "").length,
        );
      });
    }
  }

  test("source and AST words agree at arbitrary marker positions and boundary whitespace", () => {
    const source = fc
      .array(fc.constantFrom("a", "b", "č", "é", "-", " ", "\n", "\u00a0"), {
        minLength: 1,
        maxLength: 80,
      })
      .map((characters) => `start ${characters.join("")} end`);
    const whitespace = fc
      .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0"), {
        maxLength: 4,
      })
      .map((characters) => characters.join(""));
    fc.assert(
      fc.property(
        source,
        fc.nat(),
        whitespace,
        fc.constantFrom("*12", "12", "* 12"),
        whitespace,
        (text, at, leading, label, trailing) => {
          const position = at % (text.length + 1);
          const parsed = parse(
            `${text.slice(0, position)}<page-number label="12">${leading}${label}${trailing}</page-number>${text.slice(position)}`,
          );
          expect(parsed.status).toBe("parsed");
          if (parsed.status !== "parsed") {
            return;
          }
          const sourceText = cheerio
            .load(parsed.text.validationHtml)("p")
            .text();
          const astText = parsed.text.units
            .flatMap(({ blocks }) =>
              blocks.map((block) => {
                expect(block.type).toBe("paragraph");
                return block.type === "paragraph"
                  ? plainTextOf(block.inlines)
                  : "";
              }),
            )
            .join(" ");
          expect(sourceText.trim().split(/\s+/u)).toEqual(
            astText.trim().split(/\s+/u),
          );
          expect(conservesText(text, parsed.text.units)).toBe(true);
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("a passage with many mid-word labels passes the default retention guard", () => {
    const words = [
      "counsel",
      "contrary",
      "corporation",
      "obligation",
      "passengers",
      "brethren",
      "judgment",
      "affirmation",
      "evidence",
      "jurisdiction",
      "contract",
      "statutory",
      "constitution",
      "appeal",
      "defendant",
      "remedies",
      "damages",
      "testimony",
      "authority",
      "proceedings",
    ];
    const parsed = parse(
      words
        .map(
          (word) =>
            `${word.slice(0, 4)}<page-number label="12">*12</page-number>${word.slice(4)}`,
        )
        .join(" "),
    );
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed") {
      return;
    }
    const allBlocks = parsed.text.units.flatMap(({ blocks }) => [...blocks]);
    const validation = validateAst(parsed.text.validationHtml, allBlocks);
    expect(validation.ok).toBe(true);
    expect(validation.stats.missingWords).toEqual([]);

    const missing = [
      {
        id: "b1",
        anchorId: "p1",
        type: "paragraph",
        inlines: [],
        plainText: "",
      },
    ] satisfies Block[];
    expect(conservesText(words.join(" "), [])).toBe(false);
    const loss = validateAst(parsed.text.validationHtml, missing);
    expect(loss.ok).toBe(false);
    expect(loss.issues.map(({ code }) => code)).toContain("CONTENT_LOSS");
    expect(loss.issues.map(({ code }) => code)).toContain("MISSING_WORDS");
  });

  for (const printed of ["*12 omitted clause", "12 omitted clause"]) {
    test(`extra marker text is still refused: ${printed}`, () => {
      expect(
        parse(`The<page-number label="12">${printed}</page-number> court.`),
      ).toEqual({ status: "unusable", reason: "text-not-conserved" });
    });
  }
});
