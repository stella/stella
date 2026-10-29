import { describe, expect, test } from "bun:test";

import type { Block, HeadingLevel } from "./document-ast.js";
import { withDesignatorHeadingLevels } from "./heading-designator-levels.js";
import { headingPathsByAnchor } from "./heading-path.js";

const heading = (id: string, level: HeadingLevel, text: string): Block => ({
  type: "heading",
  id,
  anchorId: id,
  level,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const paragraph = (id: string): Block => ({
  type: "paragraph",
  id,
  anchorId: id,
  inlines: [{ type: "text", text: "Text." }],
  plainText: "Text.",
});

/** The titles of the headings enclosing a block, outermost first. */
const pathOf = (blocks: readonly Block[], anchorId: string) =>
  headingPathsByAnchor(blocks)
    .get(anchorId)
    ?.map(({ title }) => title);

const levelsOf = (blocks: readonly Block[]) =>
  blocks.flatMap((block) =>
    block.type === "heading" ? [[block.plainText, block.level] as const] : [],
  );

/**
 * A Court of Justice appeal as the published corpus holds it (C-602/22 P,
 * every language): each ground's dash-led subheadings stored at the ground's
 * own level.
 */
const APPEAL: Block[] = [
  heading("appeal", 2, "The appeal"),
  heading("admissibility", 3, "Admissibility of the appeal"),
  heading("admissibility-arguments", 4, "Arguments of the parties"),
  paragraph("p-42"),
  heading("substance", 3, "Substance"),
  heading("ground-1", 4, "The first ground of appeal"),
  heading("ground-1-arguments", 4, "– Arguments of the parties"),
  paragraph("p-50"),
  heading("ground-1-findings", 4, "– Findings of the Court"),
  paragraph("p-68"),
  heading("ground-2", 4, "The second ground of appeal"),
  heading("ground-2-arguments", 4, "– Arguments of the parties"),
  paragraph("p-120"),
  heading("costs", 2, "Costs"),
];

/**
 * An infringement judgment as the published corpus holds it (C-47/23, every
 * language): `A.` > `1.` > `(a)`, the lettered subheadings stored at the
 * level of the numbered complaint above them.
 */
const INFRINGEMENT: Block[] = [
  heading("analysis", 1, "V. Analysis"),
  heading("b", 2, "B. Admissibility of ‘additional examples’"),
  heading("b-1", 3, "1. Arguments of the parties"),
  paragraph("p-39"),
  heading("b-2", 3, "2. Assessment"),
  paragraph("p-45"),
  heading("c", 2, "C. The Commission’s burden of proof"),
  heading("c-1", 3, "1. The first complaint"),
  heading("c-1-a", 3, "(a) Arguments of the parties"),
  paragraph("p-52"),
  heading("c-1-b", 3, "(b) Assessment"),
  paragraph("p-60"),
  heading("c-2", 3, "2. The second complaint"),
  heading("c-2-a", 3, "(a) Arguments of the parties"),
  paragraph("p-89"),
  heading("c-2-b", 3, "(b) Assessment"),
  paragraph("p-95"),
  heading("vi", 1, "VI. Costs"),
  paragraph("p-120"),
];

describe("headings nested by their own designators", () => {
  test("stored flat, a ground's dash-led subheadings read as children of the section", () => {
    // The control: the stored levels put both copies under "Substance".
    expect(pathOf(APPEAL, "p-50")).toEqual([
      "The appeal",
      "Substance",
      "– Arguments of the parties",
    ]);
  });

  test("a dash-led subheading nests under the ground it answers", () => {
    const nested = withDesignatorHeadingLevels(APPEAL);
    expect(pathOf(nested, "p-50")).toEqual([
      "The appeal",
      "Substance",
      "The first ground of appeal",
      "– Arguments of the parties",
    ]);
    expect(pathOf(nested, "p-68")?.at(-2)).toBe("The first ground of appeal");
    expect(pathOf(nested, "p-120")?.at(-2)).toBe("The second ground of appeal");
    expect(pathOf(nested, "costs")).toEqual([]);
  });

  test("stored flat, both complaints' lettered subheadings share one path", () => {
    // The control: the duplicate the nightly reports.
    expect(pathOf(INFRINGEMENT, "p-52")).toEqual(pathOf(INFRINGEMENT, "p-89"));
  });

  test("a lettered subheading nests under the numbered complaint above it", () => {
    const nested = withDesignatorHeadingLevels(INFRINGEMENT);
    expect(pathOf(nested, "p-52")).toEqual([
      "V. Analysis",
      "C. The Commission’s burden of proof",
      "1. The first complaint",
      "(a) Arguments of the parties",
    ]);
    expect(pathOf(nested, "p-89")).toEqual([
      "V. Analysis",
      "C. The Commission’s burden of proof",
      "2. The second complaint",
      "(a) Arguments of the parties",
    ]);
    // Returning to a family seen above closes back to its level: `C.` after
    // `B.` is a letter (not the numeral 100), `2.` follows `1.`, `VI.` ends
    // the analysis.
    expect(levelsOf(nested)).toEqual([
      ["V. Analysis", 1],
      ["B. Admissibility of ‘additional examples’", 2],
      ["1. Arguments of the parties", 3],
      ["2. Assessment", 3],
      ["C. The Commission’s burden of proof", 2],
      ["1. The first complaint", 3],
      ["(a) Arguments of the parties", 4],
      ["(b) Assessment", 4],
      ["2. The second complaint", 3],
      ["(a) Arguments of the parties", 4],
      ["(b) Assessment", 4],
      ["VI. Costs", 1],
    ]);
  });

  test("only the misplaced headings change, and only in level", () => {
    for (const blocks of [APPEAL, INFRINGEMENT]) {
      const nested = withDesignatorHeadingLevels(blocks);
      expect(nested).toHaveLength(blocks.length);
      for (const [index, stored] of blocks.entries()) {
        const block = nested[index];
        if (stored.type === "heading" && block?.type === "heading") {
          expect({ ...block, level: stored.level }).toEqual(stored);
          expect(block.level).toBeGreaterThanOrEqual(stored.level);
          if (block.level === stored.level) {
            expect(block).toBe(stored);
          }
        } else {
          expect(block).toBe(stored);
        }
      }
    }
  });

  test.each([
    [
      "an outline whose stored levels already nest",
      [
        heading("i", 1, "I. Facts"),
        heading("i-a", 2, "A. The contract"),
        heading("i-a-1", 3, "1. Its terms"),
        heading("i-a-1-a", 4, "(a) Price"),
        heading("i-a-1-b", 4, "(b) Delivery"),
        heading("i-a-2", 3, "2. Its performance"),
        heading("i-b", 2, "B. The dispute"),
        heading("ii", 1, "II. Law"),
        heading("costs", 1, "Costs"),
      ],
    ],
    [
      "headings without designators",
      [
        heading("judgment", 1, "Judgment"),
        heading("facts", 2, "Background to the dispute"),
        heading("law", 2, "Findings of the Court"),
        heading("costs", 2, "Costs"),
      ],
    ],
    [
      "abbreviations that are not designators",
      [
        heading("us", 2, "Pl. ÚS 19/08"),
        heading("art", 2, "Art. 5 of the Directive"),
        heading("ns", 2, "NS. Nejvyšší soud"),
      ],
    ],
  ] as const)("%s keep their stored levels", (_case, blocks) => {
    const nested = withDesignatorHeadingLevels(blocks);
    expect(levelsOf(nested)).toEqual(levelsOf(blocks));
    for (const [index, block] of nested.entries()) {
      expect(block).toBe(blocks[index] as Block);
    }
  });
});
