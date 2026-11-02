import { describe, expect, test } from "bun:test";

import type { ParagraphBlock } from "./document-ast.js";
import { section72aSubsection1Blocks } from "./fixtures/cz-141-1961-section-72a.js";
import { section128Subsection2Blocks } from "./fixtures/sk-300-2005-section-128.js";
import { section15LetterBPoint1Blocks } from "./fixtures/sk-595-2003-section-15.js";
import {
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
  US_CODE_ANCHORS,
  wholeStatuteAnchors,
} from "./statute-anchor-scheme.js";
import type { StatuteAnchorScheme } from "./statute-anchor-scheme.js";
import {
  paragraphFromPreview,
  statuteListMarkerEnd,
  withStatuteListDepth,
} from "./statute-list.js";
import type { PreviewBlock } from "./statute-list.js";

/** A paragraph's depth and the designator the renderer hangs, as drawn. */
const drawnParagraph = (scheme: StatuteAnchorScheme, block: ParagraphBlock) => {
  const paragraph = withStatuteListDepth(block, scheme);
  const end = statuteListMarkerEnd(paragraph, scheme);
  return {
    depth: paragraph.listDepth ?? null,
    marker: end === null ? null : paragraph.plainText.slice(0, end),
  };
};

/** A provision read's block, drawn through a publisher's scheme. */
const drawnIn = (scheme: StatuteAnchorScheme) => (block: PreviewBlock) =>
  drawnParagraph(scheme, paragraphFromPreview(block));

const drawn = drawnIn(E_SBIRKA_ANCHORS);

describe("a provision's list structure", () => {
  test("a paragraph's letters nest one level under its lead-in and hang their designators", () => {
    expect(section72aSubsection1Blocks.map(drawn)).toEqual([
      { depth: null, marker: null },
      { depth: 1, marker: "a) " },
      { depth: 1, marker: "b) " },
      { depth: 1, marker: "c) " },
      { depth: 1, marker: "d) " },
    ]);
  });

  test("points nest under their letter, and what an item owns sits as deep as the item", () => {
    const blocks: PreviewBlock[] = [
      { anchorId: "par_2-odst_1", id: "1", text: "(1) Úvodní věta" },
      { anchorId: "par_2-odst_1-pism_a", id: "2", text: "a) písmeno" },
      { anchorId: "par_2-odst_1-pism_a-bod_1", id: "3", text: "1. bod" },
      { anchorId: "par_2-odst_1-pism_a-bod_12", id: "4", text: "12. bod" },
      { anchorId: "par_2-pism_aa", id: "5", text: "aa) písmeno" },
      { anchorId: "par_2-odst_1-pism_a-table_1", id: "6", text: "tabulka" },
    ];
    expect(blocks.map(drawn)).toEqual([
      { depth: null, marker: null },
      { depth: 1, marker: "a) " },
      { depth: 2, marker: "1. " },
      { depth: 2, marker: "12. " },
      { depth: 1, marker: "aa) " },
      { depth: 1, marker: null },
    ]);
  });

  test("only the designator the anchor names hangs, never a word that opens the item", () => {
    const items: PreviewBlock[] = [
      // The letter's text does not open with its own designator.
      { anchorId: "par_2-odst_1-pism_b", id: "1", text: "a) jiné písmeno" },
      // A conjunction that spells the letter is no designator.
      { anchorId: "par_2-odst_1-pism_a", id: "2", text: "a dále" },
      // No space after the designator: nothing to hang beside.
      { anchorId: "par_2-odst_1-pism_a", id: "3", text: "a)" },
      // A duplicate restates its subdivision and hangs like it.
      { anchorId: "par_2-odst_1-pism_c~2", id: "4", text: "(c) písmeno" },
    ];
    expect(items.map(drawn)).toEqual([
      { depth: 1, marker: null },
      { depth: 1, marker: null },
      { depth: 1, marker: null },
      { depth: 1, marker: "(c) " },
    ]);
  });

  test("a depth the publisher stored is kept over the anchor's", () => {
    const stored = {
      anchorId: "par_2-odst_1-pism_a",
      id: "1",
      inlines: [{ text: "a) písmeno", type: "text" }],
      listDepth: 3,
      plainText: "a) písmeno",
      type: "paragraph",
    } satisfies ParagraphBlock;
    expect(withStatuteListDepth(stored, E_SBIRKA_ANCHORS)).toBe(stored);
  });

  test("a paragraph in no list has no designator to hang", () => {
    const paragraph = paragraphFromPreview({
      anchorId: "p-7",
      id: "p-7",
      text: "a) not a statute letter",
    });
    expect(withStatuteListDepth(paragraph, E_SBIRKA_ANCHORS)).toBe(paragraph);
    expect(statuteListMarkerEnd(paragraph, E_SBIRKA_ANCHORS)).toBeNull();
  });
});

describe("e-Sbírka anchors as the Czech reader draws them", () => {
  // Real anchors and wording of 141/1961 Sb. in the consolidation in force
  // from 1 January 2026, one per paragraph anchor shape that consolidation stores. A
  // change to any row changes how a Czech statute is set.
  test("every stored anchor shape keeps its depth and its hanging designator", () => {
    const rows: PreviewBlock[] = [
      {
        anchorId: "par_139-odst_1",
        id: "3",
        text: "(1) Rozsudek je pravomocný, a nestanoví-li tento zákon něco jiného, i vykonatelný,",
      },
      {
        anchorId: "par_121-pism_a",
        id: "4",
        text: "a) o náhradě škody nebo nemajetkové újmy v penězích nebo o vydání bezdůvodného obohacení, jestliže byl nárok na náhradu škody nebo nemajetkové újmy v penězích nebo na vydání bezdůvodného obohacení včas uplatněn (§ 43 odst. 3),",
      },
      {
        anchorId: "par_11-odst_2-pism_b",
        id: "5",
        text: "b) byla osoba pravomocně zproštěna obžaloby, nebo které má účinky pravomocného zastavení trestního stíhání, ledaže",
      },
      {
        anchorId: "par_11-odst_2-pism_b-bod_1",
        id: "6",
        text: "1. nevytváří ve státě, v němž bylo vydáno, překážku věci pravomocně rozhodnuté,",
      },
      {
        anchorId: "par_139-odst_1-pism_b",
        id: "7",
        text: "b) jestliže zákon sice proti němu připouští odvolání, avšak",
      },
      {
        anchorId: "par_139-odst_1-pism_b-pism_aa",
        id: "8",
        text: "aa) odvolání ve lhůtě podáno nebylo,",
      },
      {
        anchorId: "ppc_1",
        id: "9",
        text: "1) § 58 odst. 5 zákona č. 412/2005 Sb., o ochraně utajovaných informací a o bezpečnostní způsobilosti.",
      },
    ];
    expect(
      Object.fromEntries(
        rows.map((row) => [row.anchorId, drawn(row)] as const),
      ),
    ).toEqual({
      "par_139-odst_1": { depth: null, marker: null },
      "par_121-pism_a": { depth: 1, marker: "a) " },
      "par_11-odst_2-pism_b": { depth: 1, marker: "b) " },
      "par_11-odst_2-pism_b-bod_1": { depth: 2, marker: "1. " },
      "par_139-odst_1-pism_b": { depth: 1, marker: "b) " },
      // A letter nested in a letter sits one level under it.
      "par_139-odst_1-pism_b-pism_aa": { depth: 2, marker: "aa) " },
      ppc_1: { depth: null, marker: null },
    });
  });
});

describe("Slov-Lex anchors", () => {
  const drawnSk = drawnIn(SLOV_LEX_ANCHORS);

  test("a subsection's letters nest under its lead-in, and the tail they continue does not", () => {
    expect(
      section128Subsection2Blocks.map((block) =>
        drawnParagraph(SLOV_LEX_ANCHORS, block),
      ),
    ).toEqual([
      { depth: null, marker: null },
      { depth: 1, marker: "a) " },
      { depth: 1, marker: "b) " },
      { depth: 1, marker: "c) " },
      { depth: 1, marker: "d) " },
      { depth: null, marker: null },
    ]);
  });

  test("each point in a point opens one more level and hangs its own designator", () => {
    expect(section15LetterBPoint1Blocks.map(drawnSk)).toEqual([
      { depth: 1, marker: "b) " },
      { depth: 2, marker: "1. " },
      { depth: 3, marker: "1a. " },
      { depth: 3, marker: "1b. " },
      { depth: 3, marker: "1c. " },
    ]);
  });

  test("a point a section opens directly sits one level in", () => {
    // § 439 of 300/2005 Z. z.: the repealed acts, as points of the section.
    expect(
      drawnSk({
        anchorId: "paragraf-439.bod-1",
        id: "1",
        text: "1. zákon č. 165/1950 Zb. na ochranu mieru,",
      }),
    ).toEqual({ depth: 1, marker: "1. " });
  });

  test("one publisher's anchors state no lists in the other's grammar", () => {
    const czech: PreviewBlock = {
      anchorId: "par_72a-odst_1-pism_a",
      id: "1",
      text: "a) jeden rok, je-li vedeno trestní stíhání pro přečin,",
    };
    const slovak: PreviewBlock = {
      anchorId: "paragraf-128.odsek-2.pismeno-a",
      id: "2",
      text: "a) zastávajúca funkciu v právnickej osobe,",
    };
    // Each reaches the fault boundary in its own grammar.
    expect(drawn(czech).depth).toBe(1);
    expect(drawnSk(slovak).depth).toBe(1);
    expect(drawnSk(czech)).toEqual({ depth: null, marker: null });
    expect(drawn(slovak)).toEqual({ depth: null, marker: null });
  });
});

describe("a publisher whose anchors state no lists", () => {
  test("neither nests nor hangs an item", () => {
    const paragraph = paragraphFromPreview({
      anchorId: "par_72a-odst_1-pism_a",
      id: "1",
      text: "a) jeden rok, je-li vedeno trestní stíhání pro přečin,",
    });
    const usPath = paragraphFromPreview({
      anchorId: "s1983/a/1",
      id: "2",
      text: "(1) In general.",
    });
    for (const [scheme, block] of [
      [wholeStatuteAnchors("No anchor grammar."), paragraph],
      [US_CODE_ANCHORS, usPath],
    ] as const) {
      expect(withStatuteListDepth(block, scheme)).toBe(block);
      expect(
        statuteListMarkerEnd({ ...block, listDepth: 1 }, scheme),
      ).toBeNull();
    }
  });
});
