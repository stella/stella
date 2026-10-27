import { describe, expect, test } from "bun:test";

import type { ParagraphBlock } from "./document-ast.js";
import { section72aSubsection1Blocks } from "./fixtures/cz-141-1961-section-72a.js";
import {
  paragraphFromPreview,
  statuteListMarkerEnd,
  withStatuteListDepth,
} from "./statute-list.js";
import type { PreviewBlock } from "./statute-list.js";

/** A block's depth and the designator the renderer hangs, as drawn. */
const drawn = (block: PreviewBlock) => {
  const paragraph = withStatuteListDepth(paragraphFromPreview(block));
  const end = statuteListMarkerEnd(paragraph);
  return {
    depth: paragraph.listDepth ?? null,
    marker: end === null ? null : paragraph.plainText.slice(0, end),
  };
};

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
    expect(withStatuteListDepth(stored)).toBe(stored);
  });

  test("a paragraph in no list has no designator to hang", () => {
    const paragraph = paragraphFromPreview({
      anchorId: "p-7",
      id: "p-7",
      text: "a) not a statute letter",
    });
    expect(withStatuteListDepth(paragraph)).toBe(paragraph);
    expect(statuteListMarkerEnd(paragraph)).toBeNull();
  });
});
