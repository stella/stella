/**
 * Properties of the caption recogniser over generated Czech captions whose
 * lines are known: caption lines in any order, printed one per line, grouped
 * into blocks at random and split into inlines at random, followed by the
 * opening sentences of a decision.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  CAPTION_LINE_KIND,
  CZ_CAPTION_FORMS,
  detectDecisionCaption,
} from "./decision-caption.js";
import type { CaptionLineKind } from "./decision-caption.js";
import { plainTextOf } from "./document-ast.js";
import type { Block, ParagraphBlock } from "./document-ast.js";

const LINES = {
  court: [
    "NEJVYŠŠÍ SOUD",
    "Nejvyšší soud",
    "ČESKÉ REPUBLIKY",
    "NEJVYŠŠÍ SOUD ČESKÉ REPUBLIKY",
    "Nejvyšší správní soud",
    "Krajský soud v Brně",
    "Krajský soud v Hradci Králové",
    "Obvodní soud pro Prahu 1",
    "Okresní soud v Ústí nad Labem",
  ],
  "case-number": [
    "21 Cdo 1484/2004",
    "29 ICdo 37/2013",
    "I. ÚS 245/98",
    "Pl. ÚS 1/03",
    "6 As 12/2010 - 45",
  ],
  state: ["ČESKÁ REPUBLIKA", "Česká republika"],
  "decision-type": [
    "ROZSUDEK",
    "U S N E S E N Í",
    "NÁLEZ",
    "Usnesení",
    "PLATEBNÍ ROZKAZ",
  ],
  formula: ["JMÉNEM REPUBLIKY", "Jménem republiky", "JMÉNEM ČESKÉ REPUBLIKY"],
} as const satisfies Record<CaptionLineKind, readonly string[]>;

const PROSE = [
  "Nejvyšší soud České republiky rozhodl v senátě složeném z předsedy senátu takto:",
  "Rozsudek krajského soudu se zrušuje a věc se vrací k dalšímu řízení.",
  "O d ů v o d n ě n í :",
  "Žalobce se domáhal, aby bylo určeno, že smlouva o půjčce je neplatná.",
] as const;

const lineArb = (kind: CaptionLineKind) =>
  fc.constantFrom(...LINES[kind]).map((text) => ({ kind, text }));

/** A caption: the decision type, a naming line, and any other lines. */
const captionLinesArb = fc
  .tuple(
    lineArb(CAPTION_LINE_KIND.DECISION_TYPE),
    fc
      .constantFrom(
        CAPTION_LINE_KIND.COURT,
        CAPTION_LINE_KIND.STATE,
        CAPTION_LINE_KIND.FORMULA,
      )
      .chain(lineArb),
    fc.array(
      fc.constantFrom(...Object.values(CAPTION_LINE_KIND)).chain(lineArb),
      { maxLength: 4 },
    ),
  )
  .chain(([type, naming, others]) =>
    fc.shuffledSubarray([type, naming, ...others], {
      minLength: others.length + 2,
    }),
  );

/** Whitespace a print page leaves around a line; always ends the line. */
const lineEndArb = fc.constantFrom("\n", " \n", "\t\n", "  \n  ", "\n\n");

const CUT_POINTS = fc.array(fc.nat(), { maxLength: 3 });

/** The text split into inlines at arbitrary points. */
const asParagraph = (
  id: string,
  text: string,
  cuts: readonly number[],
): ParagraphBlock => {
  const points = [
    ...new Set(cuts.map((cut) => cut % Math.max(text.length, 1))),
  ].toSorted((a, b) => a - b);
  const pieces: string[] = [];
  let from = 0;
  for (const point of points) {
    if (point > from) {
      pieces.push(text.slice(from, point));
      from = point;
    }
  }
  pieces.push(text.slice(from));
  return {
    anchorId: `p-${id}`,
    id,
    inlines: pieces.map((piece) => ({ text: piece, type: "text" })),
    plainText: text.trim(),
    type: "paragraph",
  };
};

const documentArb = captionLinesArb.chain((lines) =>
  fc.record({
    lines: fc.constant(lines),
    ends: fc.array(lineEndArb, {
      minLength: lines.length,
      maxLength: lines.length,
    }),
    // Where a block ends: after line i when breaks[i] is true.
    breaks: fc.array(fc.boolean(), {
      minLength: lines.length,
      maxLength: lines.length,
    }),
    cuts: fc.array(CUT_POINTS, {
      minLength: lines.length,
      maxLength: lines.length,
    }),
    prose: fc.array(fc.constantFrom(...PROSE), { minLength: 1, maxLength: 3 }),
  }),
);

type GeneratedDocument = {
  blocks: Block[];
  /** Per caption block, its lines in order. */
  expected: { id: string; lines: { kind: CaptionLineKind; text: string }[] }[];
};

const buildDocument = ({
  breaks,
  cuts,
  ends,
  lines,
  prose,
}: {
  breaks: boolean[];
  cuts: number[][];
  ends: string[];
  lines: { kind: CaptionLineKind; text: string }[];
  prose: string[];
}): GeneratedDocument => {
  const blocks: Block[] = [];
  const expected: GeneratedDocument["expected"] = [];
  let text = "";
  let blockLines: { kind: CaptionLineKind; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    text += line.text + (ends[index] ?? "\n");
    blockLines.push(line);
    if (breaks[index] === true || index === lines.length - 1) {
      const id = `c${String(blocks.length)}`;
      blocks.push(asParagraph(id, text, cuts[index] ?? []));
      expected.push({ id, lines: blockLines });
      text = "";
      blockLines = [];
    }
  }
  for (const [index, sentence] of prose.entries()) {
    blocks.push(asParagraph(`b${String(index)}`, sentence, []));
  }
  return { blocks, expected };
};

describe("the caption recogniser", () => {
  test("reads exactly the printed caption lines and no prose", () => {
    assertProperty(
      "reads exactly the printed caption lines and no prose",
      fc.property(documentArb, (generated) => {
        const { blocks, expected } = buildDocument(generated);
        const before = structuredClone(blocks);
        const caption = detectDecisionCaption(blocks, CZ_CAPTION_FORMS);
        expect(blocks).toEqual(before);
        expect(
          caption?.blocks.map(({ block, lines }) => {
            const text = plainTextOf(block.inlines);
            return {
              id: block.id,
              lines: lines.map(({ end, kind, start }) => ({
                kind,
                text: text.slice(start, end),
              })),
            };
          }),
        ).toEqual(expected);
      }),
    );
  });

  test("lines cover every printed character and only whitespace between", () => {
    assertProperty(
      "lines cover every printed character and only whitespace between",
      fc.property(documentArb, (generated) => {
        const caption = detectDecisionCaption(
          buildDocument(generated).blocks,
          CZ_CAPTION_FORMS,
        );
        for (const { block, lines } of caption?.blocks ?? []) {
          const text = plainTextOf(block.inlines);
          let cursor = 0;
          for (const line of lines) {
            expect(line.start).toBeGreaterThanOrEqual(cursor);
            expect(text.slice(cursor, line.start).trim()).toBe("");
            cursor = line.end;
          }
          expect(text.slice(cursor).trim()).toBe("");
        }
      }),
    );
  });
});
