import { describe, expect, test } from "bun:test";

import {
  CAPTION_LINE_KIND,
  CZ_CAPTION_FORMS,
  SK_CAPTION_FORMS,
  detectDecisionCaption,
} from "./decision-caption.js";
import type { DecisionCaption } from "./decision-caption.js";
import { plainTextOf } from "./document-ast.js";
import type { Block, ParagraphBlock } from "./document-ast.js";

const paragraph = (id: string, pieces: readonly string[]): ParagraphBlock => ({
  anchorId: `p-${id}`,
  id,
  inlines: pieces.map((text) => ({ text, type: "text" })),
  plainText: pieces.join("").trim(),
  type: "paragraph",
});

/**
 * The opening of a Supreme Court judgment as the cz-ns parser stores it from
 * an older print page: the court's first line alone, then the court's second
 * line, the docket, the state, the decision type and the formula run
 * together in one paragraph, one inline per printed line and its gaps.
 * Shaped like 21 Cdo 1484/2004; constructed for this test.
 */
const NS_RUN_ON_CAPTION = [
  paragraph("b1", ["NEJVYŠŠÍ SOUD"]),
  paragraph("b2", [
    "\n",
    "ČESKÉ REPUBLIKY\t              21 Cdo 1484/2004",
    " ",
    "\n",
    "ČESKÁ REPUBLIKA ",
    " ",
    "\n",
    "ROZSUDEK",
    " ",
    "\n",
    "JMÉNEM REPUBLIKY",
  ]),
  paragraph("b3", [
    "\n",
    "Nejvyšší soud České republiky rozhodl v senátě složeném z předsedy " +
      "senátu JUDr. Radoslava Horálka a soudců JUDr. Jiřího Kopeckého a " +
      "JUDr. Bohdana Sedly v právní věci žalobce M. P., takto:",
  ]),
] satisfies Block[];

/** Each caption block's lines as `[kind, text]`, read off its plain text. */
const linesOf = (caption: DecisionCaption | null) =>
  caption?.blocks.map(({ block, lines }) => {
    const text = plainTextOf(block.inlines);
    return {
      id: block.id,
      lines: lines.map(({ end, kind, start }) => [
        kind,
        text.slice(start, end),
      ]),
    };
  }) ?? null;

describe("a Czech caption stored run on", () => {
  test("reads as its printed lines, block by block", () => {
    expect(
      linesOf(detectDecisionCaption(NS_RUN_ON_CAPTION, CZ_CAPTION_FORMS)),
    ).toEqual([
      { id: "b1", lines: [[CAPTION_LINE_KIND.COURT, "NEJVYŠŠÍ SOUD"]] },
      {
        id: "b2",
        lines: [
          [CAPTION_LINE_KIND.COURT, "ČESKÉ REPUBLIKY"],
          [CAPTION_LINE_KIND.CASE_NUMBER, "21 Cdo 1484/2004"],
          [CAPTION_LINE_KIND.STATE, "ČESKÁ REPUBLIKA"],
          [CAPTION_LINE_KIND.DECISION_TYPE, "ROZSUDEK"],
          [CAPTION_LINE_KIND.FORMULA, "JMÉNEM REPUBLIKY"],
        ],
      },
    ]);
  });

  test("leaves the body sentence that names the court to the body", () => {
    const caption = detectDecisionCaption(NS_RUN_ON_CAPTION, CZ_CAPTION_FORMS);
    expect(caption?.blocks.map(({ block }) => block.id)).toEqual(["b1", "b2"]);
  });

  test("reads a letter-spaced decision type and a lower court's seat", () => {
    const caption = detectDecisionCaption(
      [
        paragraph("c1", [
          "Krajský soud v Hradci Králové 25 Co 12/2010 U S N E S E N Í",
        ]),
        paragraph("c2", ["Okresní soud v Ústí nad Labem rozhodl takto:"]),
      ],
      CZ_CAPTION_FORMS,
    );
    expect(linesOf(caption)).toEqual([
      {
        id: "c1",
        lines: [
          [CAPTION_LINE_KIND.COURT, "Krajský soud v Hradci Králové"],
          [CAPTION_LINE_KIND.CASE_NUMBER, "25 Co 12/2010"],
          [CAPTION_LINE_KIND.DECISION_TYPE, "U S N E S E N Í"],
        ],
      },
    ]);
  });
});

describe("a Slovak caption stored run on", () => {
  test("reads as its printed lines", () => {
    const caption = detectDecisionCaption(
      [
        paragraph("s1", [
          "NAJVYŠŠÍ SÚD SLOVENSKEJ REPUBLIKY 4Obo/45/2011 ",
          "SLOVENSKÁ REPUBLIKA ROZSUDOK V MENE SLOVENSKEJ REPUBLIKY",
        ]),
      ],
      SK_CAPTION_FORMS,
    );
    expect(linesOf(caption)).toEqual([
      {
        id: "s1",
        lines: [
          [CAPTION_LINE_KIND.COURT, "NAJVYŠŠÍ SÚD SLOVENSKEJ REPUBLIKY"],
          [CAPTION_LINE_KIND.CASE_NUMBER, "4Obo/45/2011"],
          [CAPTION_LINE_KIND.STATE, "SLOVENSKÁ REPUBLIKA"],
          [CAPTION_LINE_KIND.DECISION_TYPE, "ROZSUDOK"],
          [CAPTION_LINE_KIND.FORMULA, "V MENE SLOVENSKEJ REPUBLIKY"],
        ],
      },
    ]);
  });

  test("is not read with the Czech vocabulary", () => {
    expect(
      detectDecisionCaption(
        [paragraph("s1", ["SLOVENSKÁ REPUBLIKA ROZSUDOK"])],
        CZ_CAPTION_FORMS,
      ),
    ).toBeNull();
  });
});

describe("no caption to draw", () => {
  test("when the parser already stored each line as a heading", () => {
    const heading = (id: string, text: string): Block => ({
      anchorId: `p-${id}`,
      id,
      inlines: [{ text, type: "text" }],
      level: 3,
      plainText: text,
      type: "heading",
    });
    expect(
      detectDecisionCaption(
        [heading("h1", "ČESKÁ REPUBLIKA"), heading("h2", "ROZSUDEK")],
        CZ_CAPTION_FORMS,
      ),
    ).toBeNull();
  });

  test("when the lines name no court, state or formula", () => {
    expect(
      detectDecisionCaption(
        [paragraph("d1", ["21 Cdo 1484/2004 ROZSUDEK"])],
        CZ_CAPTION_FORMS,
      ),
    ).toBeNull();
  });

  test("when the document opens with prose", () => {
    expect(
      detectDecisionCaption(
        [
          paragraph("e1", ["Rozsudek krajského soudu se zrušuje."]),
          ...NS_RUN_ON_CAPTION,
        ],
        CZ_CAPTION_FORMS,
      ),
    ).toBeNull();
  });

  test("when a caption word carries formatting the reader must draw", () => {
    const bold: Block = {
      anchorId: "p-f1",
      id: "f1",
      inlines: [
        { children: [{ text: "ROZSUDEK", type: "text" }], type: "bold" },
        { text: " JMÉNEM REPUBLIKY", type: "text" },
      ],
      plainText: "ROZSUDEK JMÉNEM REPUBLIKY",
      type: "paragraph",
    };
    expect(detectDecisionCaption([bold], CZ_CAPTION_FORMS)).toBeNull();
  });
});
