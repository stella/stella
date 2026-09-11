import { describe, expect, test } from "bun:test";

import type { Block, HeadingBlock } from "@stll/legal-ast/document-ast";

import {
  prepareStatuteReader,
  provisionCitationCountByBlockAnchor,
} from "@/features/statutes/statute-reader-blocks";

const inlineText = (text: string) => [{ type: "text" as const, text }];

const heading = (
  id: string,
  level: 1 | 2,
  plainText: string,
): HeadingBlock => ({
  anchorId: id,
  id,
  inlines: inlineText(plainText),
  level,
  plainText,
  type: "heading",
});

describe("statute reader blocks", () => {
  test("preamble prose cannot become a wall of display headings", () => {
    const blocks = [
      heading("masthead", 1, "LISTINA ZÁKLADNÍCH PRÁV A SVOBOD"),
      heading(
        "preamble-1",
        1,
        "pamětlivo trpkých zkušeností z dob, kdy lidská práva byla potlačována,",
      ),
      heading(
        "preamble-2",
        1,
        "vkládajíc naděje do zabezpečení těchto práv společným úsilím,",
      ),
      heading("hlava-1", 1, "HLAVA PRVNÍ\nOBECNÁ USTANOVENÍ"),
      heading("cl-1", 2, "Čl. 1"),
    ];

    const prepared = prepareStatuteReader({
      blocks,
      statuteTitle: "2/1993 Sb., Listina základních práv a svobod",
    }).blocks;

    expect(prepared.slice(0, 3).map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(prepared.slice(0, 3).map((block) => block.plainText)).toEqual(
      blocks.slice(0, 3).map((block) => block.plainText),
    );
    expect(prepared.slice(3).map((block) => block.type)).toEqual([
      "heading",
      "heading",
    ]);
  });

  test("publisher title fragments become one structured masthead", () => {
    const blocks: Block[] = [
      {
        ...heading(
          "masthead",
          1,
          "67 ZÁKON ze dne 19. února 2013, kterým se upravují některé otázky",
        ),
        role: "decision-title",
      },
      heading("par-1", 1, "§ 1\nÚvodní ustanovení"),
    ];

    const prepared = prepareStatuteReader({
      blocks,
      statuteTitle: "67/2013 Sb., kterým se upravují některé otázky",
    });

    expect(prepared.masthead).toEqual({
      anchorId: "masthead",
      citation: "67/2013 Sb.",
      date: "ze dne 19. února 2013",
      instrument: "ZÁKON",
      issuer: null,
      title: "kterým se upravují některé otázky",
    });
    expect(prepared.blocks.map((block) => block.anchorId)).toEqual(["par-1"]);
  });

  test("known source footnotes regain linked superscript references", () => {
    const bodyText =
      "(1) Tento zákon zapracovává příslušné předpisy Evropské unie2) a upravuje další otázky.";
    const blocks: Block[] = [
      {
        anchorId: "par_1-odst_1",
        id: "body",
        inlines: inlineText(bodyText),
        plainText: bodyText,
        type: "paragraph",
      },
      {
        anchorId: "ppc_2",
        id: "note-2",
        inlines: inlineText("2) Čl. 13 směrnice Evropské unie."),
        plainText: "2) Čl. 13 směrnice Evropské unie.",
        type: "paragraph",
      },
    ];

    const prepared = prepareStatuteReader({
      blocks,
      statuteTitle: "67/2013 Sb., zákon o službách",
    }).blocks;
    const body = prepared.at(0);
    const note = prepared.at(1);

    expect(body?.plainText).toBe(bodyText);
    expect(body?.type).toBe("paragraph");
    if (body?.type === "paragraph") {
      expect(body.inlines).toContainEqual({
        children: [{ text: "2)", type: "text" }],
        href: "#ppc_2",
        type: "link",
      });
    }
    expect(note?.type).toBe("paragraph");
    if (note?.type === "paragraph") {
      expect(note.note).toEqual({
        label: "2",
        noteId: "ppc_2",
        type: "footnote",
      });
    }
  });

  test("unmatched parenthesized numbers remain ordinary text", () => {
    const text = "Body2) but the source has no matching note.";
    const prepared = prepareStatuteReader({
      blocks: [
        {
          anchorId: "body",
          id: "body",
          inlines: inlineText(text),
          plainText: text,
          type: "paragraph",
        },
      ],
      statuteTitle: "67/2013 Sb., zákon o službách",
    }).blocks.at(0);

    expect(prepared?.type).toBe("paragraph");
    if (prepared?.type === "paragraph") {
      expect(prepared.inlines).toEqual(inlineText(text));
    }
  });

  test("e-Sbírka anchor paths recover nested list indentation", () => {
    const prepared = prepareStatuteReader({
      blocks: [
        {
          anchorId: "par_2-odst_1",
          id: "paragraph",
          inlines: inlineText("(1) Intro"),
          plainText: "(1) Intro",
          type: "paragraph",
        },
        {
          anchorId: "par_2-odst_1-pism_a",
          id: "letter",
          inlines: inlineText("a) provider"),
          plainText: "a) provider",
          type: "paragraph",
        },
        {
          anchorId: "par_2-odst_1-pism_a-bod_1",
          id: "point",
          inlines: inlineText("1. owner"),
          plainText: "1. owner",
          type: "paragraph",
        },
      ],
      statuteTitle: "67/2013 Sb., zákon o službách",
    }).blocks;

    expect(
      prepared.map((block) =>
        block.type === "paragraph" ? block.listDepth : undefined,
      ),
    ).toEqual([undefined, 1, 2]);
  });

  test("citation counts follow namespaced publisher anchors", () => {
    const blocks = [heading("prilohy-cl_7", 2, "Čl. 7")];

    expect(
      provisionCitationCountByBlockAnchor(blocks, [
        { anchor: "cl_7", decisionCount: 12 },
      ]).get("prilohy-cl_7"),
    ).toBe(12);
  });
});
