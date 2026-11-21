import { describe, expect, test } from "bun:test";

import type {
  Block,
  HeadingBlock,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";
import { E_SBIRKA_ANCHORS } from "@stll/legal-ast/statute-anchor-scheme";

import {
  prepareStatuteReader,
  provisionCitationCountByBlockAnchor,
  statuteLandingAnchorIds,
} from "@/features/statutes/statute-reader-blocks";

/** A Czech statute's blocks, read in e-Sbírka's anchor grammar. */
const czech = (blocks: readonly Block[]) => ({
  blocks,
  scheme: E_SBIRKA_ANCHORS,
});

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

const paragraph = (id: string, plainText: string): ParagraphBlock => ({
  anchorId: id,
  id,
  inlines: inlineText(plainText),
  plainText,
  type: "paragraph",
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

  test("lettered notes an amendment inserted are footnotes too", () => {
    const bodyText =
      "(1) Řízení o dávce nemocenského pojištění80b) a úrazového pojištění80c) upravuje zvláštní zákon.";
    const noteText = "80b) Zákon č. 187/2006 Sb., o nemocenském pojištění.";
    const blocks: Block[] = [
      {
        anchorId: "par_1-odst_1",
        id: "body",
        inlines: inlineText(bodyText),
        plainText: bodyText,
        type: "paragraph",
      },
      {
        anchorId: "ppc_80",
        id: "note-80",
        inlines: inlineText("80) § 71a zákona č. 358/1992 Sb."),
        plainText: "80) § 71a zákona č. 358/1992 Sb.",
        type: "paragraph",
      },
      {
        anchorId: "ppc_80b",
        id: "note-80b",
        inlines: inlineText(noteText),
        plainText: noteText,
        type: "paragraph",
      },
    ];

    const prepared = prepareStatuteReader({
      blocks,
      statuteTitle: "99/1963 Sb., občanský soudní řád",
    }).blocks;
    const body = prepared.at(0);
    const note = prepared.at(2);

    expect(body?.type).toBe("paragraph");
    if (body?.type === "paragraph") {
      expect(body.inlines).toContainEqual({
        children: [{ text: "80b)", type: "text" }],
        href: "#ppc_80b",
        type: "link",
      });
      // The document carries no note 80c, so its marker stays text.
      expect(
        body.inlines.some(
          (inline) => inline.type === "link" && inline.href === "#ppc_80c",
        ),
      ).toBe(false);
    }
    expect(note?.type).toBe("paragraph");
    if (note?.type === "paragraph") {
      expect(note.note).toEqual({
        label: "80b",
        noteId: "ppc_80b",
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

  test("citation counts follow namespaced publisher anchors", () => {
    const blocks = [heading("prilohy-cl_7", 2, "Čl. 7")];

    expect(
      provisionCitationCountByBlockAnchor(czech(blocks), [
        { anchor: "cl_7", decisionCount: 12 },
      ]).get("prilohy-cl_7"),
    ).toBe(12);
  });

  test("a statute tab lands on the block its link names", () => {
    const blocks = [
      heading("cl_7", 2, "Čl. 7"),
      heading("prilohy-cl_8", 2, "Čl. 8"),
      heading("hlava_1-par_9", 2, "§ 9"),
      heading("hlava_2-par_9", 2, "§ 9"),
    ];

    const landing = (anchorId: string | undefined) =>
      statuteLandingAnchorIds(czech(blocks), { anchorId });

    expect(landing("cl_7")).toEqual(["cl_7"]);
    // The local provision id a citation states finds the namespaced block
    // the publisher rendered.
    expect(landing("cl_8")).toEqual(["prilohy-cl_8"]);
    // Two blocks answer to it: guessing would land on the wrong provision.
    expect(landing("par_9")).toEqual([]);
    expect(landing("cl_99")).toEqual([]);
    expect(landing(undefined)).toEqual([]);
  });

  test("a statute tab marks the paragraphs its citation names", () => {
    const blocks = [
      heading("par_240", 2, "§ 240"),
      paragraph("par_240-odst_1", "(1) Účastník může podat dovolání"),
      paragraph("par_240-odst_2", "(2) Zmeškání lhůty"),
      paragraph("par_240-odst_3", "(3) Lhůta je zachována také tehdy"),
    ];
    const landing = (citedAnchorIds: readonly string[]) =>
      statuteLandingAnchorIds(czech(blocks), {
        anchorId: "par_240",
        citedAnchorIds,
      });

    expect(landing(["par_240-odst_3"])).toEqual(["par_240-odst_3"]);
    expect(landing(["par_240-odst_1", "par_240-odst_2"])).toEqual([
      "par_240-odst_1",
      "par_240-odst_2",
    ]);
    // A paragraph the text does not hold is dropped; with none held, the
    // provision the link names is marked as before.
    expect(landing(["par_240-odst_9", "par_240-odst_2"])).toEqual([
      "par_240-odst_2",
    ]);
    expect(landing(["par_240-odst_9"])).toEqual(["par_240"]);
  });
});
