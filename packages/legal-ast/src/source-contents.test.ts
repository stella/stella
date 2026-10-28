import { describe, expect, test } from "bun:test";

import { normalizeUnicode } from "@stll/text-normalize";

import { visibleDecisionBlocks } from "./case-law-reader.js";
import { DECISION_IDENTIFIER_TYPES } from "./decision-identifier.js";
import type { Block, DocumentAst } from "./document-ast.js";
import {
  comparableHeadingTitle,
  leadingSourceContentsBlockIds,
} from "./source-contents.js";

const paragraph = (id: string, text: string): Block => ({
  type: "paragraph",
  id,
  anchorId: id,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const heading = (id: string, text: string): Block => ({
  type: "heading",
  id,
  anchorId: id,
  level: 2,
  inlines: [{ type: "text", text }],
  plainText: text,
});

/** The shape a General Court judgment arrives in: its contents, then the text. */
const JUDGMENT: Block[] = [
  paragraph("title", "ROZSUDEK SOUDU PRVNÍHO STUPNĚ (druhého senátu)"),
  paragraph("toc-1", "Účastníci řízení"),
  paragraph("toc-2", "Odůvodnění rozsudku"),
  paragraph("toc-3", "Výrok"),
  heading("parties", "Účastníci řízení"),
  paragraph("p1", "Ve věci T-33/03, Osterreichische Postsparkasse AG, ..."),
  heading("grounds", "Odůvodnění rozsudku"),
  paragraph("p2", "Skutkový základ sporu je tento."),
  heading("ruling", "Výrok"),
  paragraph("p3", "Žaloba se zamítá."),
];

describe("a publisher's leading table of contents", () => {
  test("its lines are found when each names a later heading in order", () => {
    expect([...leadingSourceContentsBlockIds(JUDGMENT)]).toEqual([
      "toc-1",
      "toc-2",
      "toc-3",
    ]);
  });

  test("the reader leaves the lines out and keeps every heading and paragraph", () => {
    const ast: DocumentAst = {
      version: 1,
      source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
      metadata: {
        caseNumber: "T-33/03",
        ecli: null,
        court: "Tribunál",
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: JUDGMENT,
    };
    const visible = visibleDecisionBlocks(
      ast,
      DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    ).map(({ id }) => id);
    expect(visible).toEqual([
      "title",
      "parties",
      "p1",
      "grounds",
      "p2",
      "ruling",
      "p3",
    ]);
    // The stored document is untouched: only the view leaves the lines out.
    expect(ast.blocks).toHaveLength(JUDGMENT.length);
  });

  test("case, spacing and closing punctuation do not hide a contents line", () => {
    const blocks = [
      paragraph("toc-1", "ÚČASTNÍCI   ŘÍZENÍ:"),
      paragraph("toc-2", "Výrok."),
      heading("parties", "Účastníci řízení"),
      heading("ruling", "Výrok"),
    ];
    expect([...leadingSourceContentsBlockIds(blocks)]).toEqual([
      "toc-1",
      "toc-2",
    ]);
  });

  test.each([
    [
      "a single line naming a heading",
      [paragraph("line", "Výrok"), heading("ruling", "Výrok")],
    ],
    [
      "lines naming headings in another order",
      [
        paragraph("a", "Výrok"),
        paragraph("b", "Účastníci řízení"),
        heading("parties", "Účastníci řízení"),
        heading("ruling", "Výrok"),
      ],
    ],
    [
      "lines naming headings that came before them",
      [
        heading("parties", "Účastníci řízení"),
        heading("ruling", "Výrok"),
        paragraph("a", "Účastníci řízení"),
        paragraph("b", "Výrok"),
      ],
    ],
    [
      "lines no heading carries",
      [
        paragraph("a", "Žaloba se zamítá."),
        paragraph("b", "Žalobkyně ponese náklady řízení."),
        heading("ruling", "Výrok"),
      ],
    ],
    [
      "a document with no headings",
      [paragraph("a", "Výrok"), paragraph("b", "Odůvodnění")],
    ],
  ] as const)("text stays when it is %s", (_case, blocks) => {
    expect(leadingSourceContentsBlockIds(blocks).size).toBe(0);
  });

  test("the lines are hidden only up to the last one that names a later heading", () => {
    const blocks = [
      paragraph("toc-1", "Účastníci řízení"),
      paragraph("toc-2", "Výrok"),
      paragraph("note", "Jazyk řízení: němčina"),
      heading("parties", "Účastníci řízení"),
      heading("ruling", "Výrok"),
    ];
    expect([...leadingSourceContentsBlockIds(blocks)]).toEqual([
      "toc-1",
      "toc-2",
    ]);
  });
});

describe("comparable heading titles", () => {
  test("composed and decomposed spellings compare equal", () => {
    const composed = "Účastníci řízení";
    const decomposed = normalizeUnicode(composed, "NFD");
    expect(decomposed).not.toBe(composed);
    expect(comparableHeadingTitle(decomposed)).toBe(
      comparableHeadingTitle(composed),
    );
  });
});
