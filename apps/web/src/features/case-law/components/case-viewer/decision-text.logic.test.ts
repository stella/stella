import { describe, expect, test } from "bun:test";

import type {
  Block,
  DocumentAst,
  ParagraphNote,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

import {
  annotationsOverlappingTextSpan,
  apparatusBlockIds,
  editorialSupplementBlocks,
  footnoteParts,
  visibleDecisionBlocks,
} from "@/features/case-law/components/case-viewer/decision-text.logic";

describe("annotations crossing links", () => {
  test("keeps every intersecting mark over the linked text", () => {
    const annotations = [
      { id: "contains", startOffset: 2, endOffset: 20 },
      { id: "starts-inside", startOffset: 8, endOffset: 18 },
      { id: "ends-inside", startOffset: 0, endOffset: 7 },
      { id: "before", startOffset: 0, endOffset: 5 },
      { id: "after", startOffset: 10, endOffset: 14 },
    ];

    expect(
      annotationsOverlappingTextSpan(annotations, { start: 5, end: 10 }).map(
        ({ id }) => id,
      ),
    ).toEqual(["contains", "starts-inside", "ends-inside"]);
  });
});

describe("editorial supplement blocks", () => {
  test("uses publisher-preserved blank lines as the authoritative boundaries", () => {
    const source =
      "Analytická právní věta\n\nPlošné údaje eJustice zpracovala.Nespojená věta zůstává v témže zdrojovém bloku.\n\nNávrh a řízení před Ústavním soudem";

    expect(
      editorialSupplementBlocks(source).map(({ text, type }) => ({
        text,
        type,
      })),
    ).toEqual([
      { text: "Analytická právní věta", type: "heading" },
      {
        text: "Plošné údaje eJustice zpracovala.Nespojená věta zůstává v témže zdrojovém bloku.",
        type: "paragraph",
      },
      {
        text: "Návrh a řízení před Ústavním soudem",
        type: "heading",
      },
    ]);
  });

  test("recovers NALUS headings and paragraph boundaries without changing offsets", () => {
    const source =
      "Analytická právní větaPlošné shromažďování údajů je nepřípustné.Návrh a řízení před Ústavním soudemPlénum návrhu vyhovělo.Dle navrhovatelů šlo o zásah.Odůvodnění rozhodnutí Ústavního souduV souvislosti s návrhem soud rozhodl.";
    const blocks = editorialSupplementBlocks(source);

    expect(blocks.map(({ text, type }) => ({ text, type }))).toEqual([
      { text: "Analytická právní věta", type: "heading" },
      {
        text: "Plošné shromažďování údajů je nepřípustné.",
        type: "paragraph",
      },
      {
        text: "Návrh a řízení před Ústavním soudem",
        type: "heading",
      },
      { text: "Plénum návrhu vyhovělo.", type: "paragraph" },
      { text: "Dle navrhovatelů šlo o zásah.", type: "paragraph" },
      {
        text: "Odůvodnění rozhodnutí Ústavního soudu",
        type: "heading",
      },
      {
        text: "V souvislosti s návrhem soud rozhodl.",
        type: "paragraph",
      },
    ]);
    for (const block of blocks) {
      expect(source.slice(block.start, block.end)).toBe(block.text);
    }
  });

  test("does not split an early mixed-case word", () => {
    expect(
      editorialSupplementBlocks("Služba eJustice zůstala dostupná."),
    ).toEqual([
      {
        end: "Služba eJustice zůstala dostupná.".length,
        start: 0,
        text: "Služba eJustice zůstala dostupná.",
        type: "paragraph",
      },
    ]);
  });
});

const ast = {
  version: 1,
  source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "1 As 1/2026",
    ecli: null,
    court: "Nejvyšší správní soud",
    decisionDate: null,
    decisionType: "Rozsudek",
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "case-number",
      anchorId: "case-number",
      type: "paragraph",
      role: "case-number",
      inlines: [{ type: "text", text: "1 As 1/2026" }],
      plainText: "1 As 1/2026",
    },
    {
      id: "title",
      anchorId: "title",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: "JMÉNEM REPUBLIKY" }],
      plainText: "JMÉNEM REPUBLIKY",
    },
    {
      id: "related",
      anchorId: "related",
      type: "table",
      role: "related-proceedings",
      rows: [],
      plainText: "Related proceedings",
    },
    {
      id: "body",
      anchorId: "body",
      type: "paragraph",
      inlines: [{ type: "text", text: "Body" }],
      plainText: "Body",
    },
  ],
} as const satisfies DocumentAst;

describe("visible decision blocks", () => {
  test("keeps semantic headings while removing separately rendered metadata", () => {
    expect(visibleDecisionBlocks(ast).map((block) => block.id)).toEqual([
      "title",
      "body",
    ]);
  });

  test("repairs legacy same-line Roman headings after Odůvodnění", () => {
    const legacyAst = {
      ...ast,
      blocks: [
        {
          anchorId: "reasoning",
          id: "reasoning",
          inlines: [{ text: "Odůvodnění:", type: "text" }],
          level: 2,
          plainText: "Odůvodnění:",
          role: "section-heading",
          type: "heading",
        },
        {
          anchorId: "p-127",
          id: "b127",
          inlines: [{ text: "VIII. Vlastní přezkum", type: "text" }],
          plainText: "VIII. Vlastní přezkum",
          type: "paragraph",
        },
        {
          anchorId: "p-128",
          id: "b128",
          inlines: [{ text: "VIII. A) Tzv. data retention", type: "text" }],
          plainText: "VIII. A) Tzv. data retention",
          type: "paragraph",
        },
      ],
    } as const satisfies DocumentAst;

    expect(
      visibleDecisionBlocks(legacyAst).map((block) => ({
        anchorId: block.anchorId,
        level: block.type === "heading" ? block.level : null,
        text: block.plainText,
        type: block.type,
      })),
    ).toEqual([
      {
        anchorId: "reasoning",
        level: 2,
        text: "Odůvodnění:",
        type: "heading",
      },
      {
        anchorId: "p-127",
        level: 3,
        text: "VIII. Vlastní přezkum",
        type: "heading",
      },
      {
        anchorId: "p-128",
        level: 4,
        text: "VIII. A) Tzv. data retention",
        type: "heading",
      },
    ]);
  });
});

const noteBlocks = (notes: readonly (ParagraphNote | undefined)[]): Block[] =>
  notes.map((note, index) => ({
    id: `b${String(index)}`,
    anchorId: `b-${String(index)}`,
    type: "paragraph",
    ...(note === undefined ? {} : { note }),
    inlines: [{ type: "text", text: "Note" }],
    plainText: "Note",
  }));

describe("footnote parts", () => {
  test("a note printed over several paragraphs opens once and jumps back from its head", () => {
    const blocks = noteBlocks([
      { type: "footnote", label: "1", noteId: "n1" },
      { type: "footnote", label: "1", noteId: "n1" },
      { type: "footnote", label: "1", noteId: "n1" },
    ]);
    const { headIds, backJumpAnchorByLastId } = footnoteParts(blocks);

    expect([...headIds]).toEqual(["b0"]);
    expect([...backJumpAnchorByLastId]).toEqual([["b2", "b-0"]]);
  });

  test("notes with no shared identity are each complete by themselves", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([
        { type: "footnote", label: "1" },
        { type: "footnote", label: "2" },
      ]),
    );

    expect([...headIds]).toEqual(["b0", "b1"]);
    expect([...backJumpAnchorByLastId]).toEqual([
      ["b0", "b-0"],
      ["b1", "b-1"],
    ]);
  });

  test("adjacent notes with different identities do not merge", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([
        { type: "footnote", label: "1", noteId: "n1" },
        { type: "footnote", label: "2", noteId: "n2" },
      ]),
    );

    expect([...headIds]).toEqual(["b0", "b1"]);
    expect([...backJumpAnchorByLastId]).toEqual([
      ["b0", "b-0"],
      ["b1", "b-1"],
    ]);
  });

  test("a body paragraph between two parts breaks the run", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([
        { type: "footnote", label: "1", noteId: "n1" },
        undefined,
        { type: "footnote", label: "1", noteId: "n1" },
      ]),
    );

    expect([...headIds]).toEqual(["b0", "b2"]);
    expect([...backJumpAnchorByLastId]).toEqual([
      ["b0", "b-0"],
      ["b2", "b-2"],
    ]);
  });

  test("a body paragraph is neither a head nor a last part", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([undefined]),
    );

    expect([...headIds]).toEqual([]);
    expect(backJumpAnchorByLastId.size).toBe(0);
  });
});

describe("apparatus block ids", () => {
  const roleBlocks = (roles: readonly (ParagraphRole | undefined)[]): Block[] =>
    roles.map((role, index) => ({
      id: role ?? "no-role",
      anchorId: `a-${String(index)}`,
      type: "paragraph",
      ...(role === undefined ? {} : { role }),
      inlines: [],
      plainText: "",
    }));

  test("folds every publisher-authored role, and leaves the bench alone", () => {
    expect([
      ...apparatusBlockIds(
        roleBlocks([
          "apparatus",
          "syllabus",
          "headnotes",
          "summary",
          "counsel",
          "panel",
          "intro",
          undefined,
        ]),
      ),
    ]).toEqual(["apparatus", "syllabus", "headnotes", "summary", "counsel"]);
  });
});
