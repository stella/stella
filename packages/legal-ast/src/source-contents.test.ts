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

const astOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "T-33/03",
    ecli: null,
    court: "General Court",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
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
  paragraph("p1", "Ve věci T-33/03,"),
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

/**
 * The shape the published corpus holds for the General Court's older
 * judgments in every language: the contents as ONE block whose lines are the
 * titles (each line after the first indented by a space), before the first
 * heading. Titles as the versions of T-33/03 print them.
 */
const CONTENTS_BLOCK_VERSIONS = [
  ["cs", ["Účastníci řízení", "Odůvodnění rozsudku", "Výrok"]],
  ["da", ["Parter", "Dommens præmisser", "Afgørelse"]],
  ["de", ["Parteien", "Entscheidungsgründe", "Kostenentscheidung", "Tenor"]],
  ["el", ["Διάδικοι", "Σκεπτικό της απόφασης", "Διατακτικό"]],
  ["en", ["Parties", "Grounds", "Decision on costs", "Operative part"]],
  ["fi", ["Asianosaiset", "Tuomion perustelut", "Päätöksen päätösosa"]],
  ["fr", ["Parties", "Motifs de l'arrêt", "Dispositif"]],
  ["hu", ["Felek", "Az ítélet indoklása", "Rendelkező rész"]],
] as const;

describe("a contents list published as one block", () => {
  test.each(CONTENTS_BLOCK_VERSIONS)(
    "the %s version opens on the text, not on its contents",
    (_language, titles) => {
      const blocks: Block[] = [
        paragraph("contents", titles.join("\n ")),
        ...titles.flatMap((title, index) => [
          heading(`h-${String(index)}`, title),
          paragraph(`p-${String(index)}`, "1. Text of the part."),
        ]),
      ];
      expect([...leadingSourceContentsBlockIds(blocks)]).toEqual(["contents"]);
      const visible = visibleDecisionBlocks(
        { ...astOf(blocks) },
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      );
      expect(visible.map(({ id }) => id)).toEqual(
        blocks.slice(1).map(({ id }) => id),
      );
    },
  );

  test("a block whose lines name no later heading is text, and stays", () => {
    const blocks: Block[] = [
      paragraph("address", "Rue du Fort Niedergrünewald\n L-2925 Luxembourg"),
      heading("parties", "Parties"),
    ];
    expect(leadingSourceContentsBlockIds(blocks).size).toBe(0);
  });

  test("a block listing headings that came before it stays", () => {
    const blocks: Block[] = [
      heading("parties", "Parties"),
      heading("grounds", "Grounds"),
      paragraph("recap", "Parties\n Grounds"),
    ];
    expect(leadingSourceContentsBlockIds(blocks).size).toBe(0);
  });
});

describe("comparable heading titles", () => {
  test("a subheading's leading dash does not make it another title", () => {
    expect(comparableHeadingTitle("– Arguments of the parties")).toBe(
      comparableHeadingTitle("Arguments of the parties"),
    );
  });

  test("composed and decomposed spellings compare equal", () => {
    const composed = "Účastníci řízení";
    const decomposed = normalizeUnicode(composed, "NFD");
    expect(decomposed).not.toBe(composed);
    expect(comparableHeadingTitle(decomposed)).toBe(
      comparableHeadingTitle(composed),
    );
  });
});
