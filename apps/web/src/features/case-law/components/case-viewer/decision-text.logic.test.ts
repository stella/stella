import { describe, expect, test } from "bun:test";

import type {
  Block,
  DocumentAst,
  ParagraphNote,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

import {
  apparatusBlockIds,
  footnoteParts,
  visibleDecisionBlocks,
} from "@/features/case-law/components/case-viewer/decision-text.logic";

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
