import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";
import {
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
} from "@stll/legal-ast/statute-anchor-scheme";

import { extractProvisionText } from "@/api/handlers/legislation/provision-text";

/** Written as an escape so the fixture text is unambiguous in review. */
const SECTION_SIGN = "\u00a7";

const heading = (anchorId: string, level: 1 | 2 | 3, text: string): Block => ({
  id: `h-${anchorId}`,
  anchorId,
  type: "heading",
  level,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const paragraph = (anchorId: string, text: string): Block => ({
  id: `p-${anchorId}`,
  anchorId,
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

/** Blocks read in e-Sbírka's grammar, whose anchors nest on `-`. */
const czech = (blocks: readonly Block[]) => ({
  blocks,
  scheme: E_SBIRKA_ANCHORS,
});

const blocks: Block[] = [
  heading("chapter-1", 1, "Chapter I"),
  paragraph("intro", "Introductory note."),
  heading("sec-1", 2, "Section 1"),
  paragraph("sec-1-1", "First rule."),
  heading("sec-1-a", 3, "Section 1a"),
  paragraph("sec-1-a-1", "Nested rule."),
  heading("sec-2", 2, "Section 2"),
  paragraph("sec-2-1", "Second rule."),
  heading("chapter-2", 1, "Chapter II"),
  paragraph("chapter-2-1", "Rule of the next chapter."),
];

describe("extractProvisionText", () => {
  test("keeps the provision's own blocks and its nested subdivisions", () => {
    expect(extractProvisionText(czech(blocks), "sec-1")).toBe(
      ["Section 1", "First rule.", "Section 1a", "Nested rule."].join("\n"),
    );
  });

  test("stops at the next heading of the same level", () => {
    expect(extractProvisionText(czech(blocks), "sec-1")).not.toContain(
      "Second rule.",
    );
  });

  test("stops at a shallower heading", () => {
    // The fixture closes with a level-1 heading, so a rule that only stopped
    // at same-level headings would swallow the next chapter.
    expect(extractProvisionText(czech(blocks), "sec-2")).toBe(
      ["Section 2", "Second rule."].join("\n"),
    );
  });

  test("takes everything under a top-level heading", () => {
    const chapter = extractProvisionText(czech(blocks), "chapter-1");

    expect(chapter).toContain("Second rule.");
    expect(chapter).not.toContain("Rule of the next chapter.");
  });

  test("reads an unknown anchor as absent, not as empty", () => {
    expect(extractProvisionText(czech(blocks), "sec-404")).toBeNull();
  });

  test("resolves an unambiguous provision nested under a structural prefix", () => {
    const annexed = [
      heading("annex-cl_7", 2, "Čl. 7"),
      paragraph(
        "annex-cl_7-odst_1",
        "Nedotknutelnost osoby a jejího soukromí je zaručena.",
      ),
      heading("annex-cl_8", 2, "Čl. 8"),
    ];

    expect(extractProvisionText(czech(annexed), "cl_7")).toBe(
      "Čl. 7\nNedotknutelnost osoby a jejího soukromí je zaručena.",
    );
  });

  test("files a subdivision under the longest heading it continues", () => {
    // `sec-1-1` continues `sec-1`, and `sec-1-a-1` continues `sec-1-a`
    // rather than `sec-1`: the document says which heading owns it, whatever
    // separators the heading's own anchor carries.
    expect(extractProvisionText(czech(blocks), "sec-1-1")).toBe("First rule.");
    expect(extractProvisionText(czech(blocks), "sec-1-a-1")).toBe(
      "Nested rule.",
    );
  });

  test("reads an anchor whose provision cannot be located as absent", () => {
    // No heading in this fixture is continued by `sec-9-1`, so nothing files it.
    expect(extractProvisionText(czech(blocks), "sec-9-1")).toBeNull();
  });
});

/**
 * The publisher's own grammar: a provision heading, then the subdivisions
 * filed under it by anchor path. Both spellings are addressable, because both
 * are what a citation names.
 */
const czechBlocks: Block[] = [
  heading("par_1729", 3, `${SECTION_SIGN} 1729`),
  paragraph("par_1729-odst_1", "(1) The engaged persons choose the rite."),
  paragraph("par_1729-odst_2", "(2) Otherwise:"),
  paragraph("par_1729-odst_2-pism_a", "a) the first case,"),
  paragraph("par_1729-odst_2-pism_b", "b) the second case."),
  heading("par_1730", 3, `${SECTION_SIGN} 1730`),
  paragraph("par_1730-odst_1", "(1) The next provision."),
];

describe("extractProvisionText: subdivision anchors", () => {
  test("keeps the whole provision for its heading anchor", () => {
    expect(extractProvisionText(czech(czechBlocks), "par_1729")).toBe(
      [
        `${SECTION_SIGN} 1729`,
        "(1) The engaged persons choose the rite.",
        "(2) Otherwise:",
        "a) the first case,",
        "b) the second case.",
      ].join("\n"),
    );
  });

  test("narrows to one subdivision", () => {
    expect(extractProvisionText(czech(czechBlocks), "par_1729-odst_1")).toBe(
      "(1) The engaged persons choose the rite.",
    );
  });

  test("keeps the subdivisions nested under a cited one", () => {
    // Nesting lives in the anchor path, not in a heading level, and stops
    // before the next sibling paragraph.
    expect(extractProvisionText(czech(czechBlocks), "par_1729-odst_2")).toBe(
      ["(2) Otherwise:", "a) the first case,", "b) the second case."].join(
        "\n",
      ),
    );
  });

  test("reads a subdivision the provision does not carry as absent", () => {
    // Never the provision body instead: that would answer with neighbouring
    // wording under an anchor the consolidation never had.
    expect(
      extractProvisionText(czech(czechBlocks), "par_1729-odst_9"),
    ).toBeNull();
    expect(
      extractProvisionText(czech(czechBlocks), "par_9999-odst_1"),
    ).toBeNull();
  });
});

/**
 * Slov-Lex files subdivisions under the section heading by `.`-joined
 * segments; a segment joins its kind and value with `-`.
 */
const slovakBlocks: Block[] = [
  heading("paragraf-36", 3, `${SECTION_SIGN} 36`),
  paragraph("paragraf-36.odsek-1", "(1) Návrh obsahuje"),
  paragraph("paragraf-36.pismeno-a", "a) označenie súdu,"),
  paragraph("paragraf-36.pismeno-a.bod-1", "1. sídlo súdu,"),
  paragraph("paragraf-36.pismeno-b", "b) označenie účastníkov."),
  heading("paragraf-37", 3, `${SECTION_SIGN} 37`),
  paragraph("paragraf-37.odsek-1", "(1) Ďalšie ustanovenie."),
];

const slovak = { blocks: slovakBlocks, scheme: SLOV_LEX_ANCHORS };

describe("extractProvisionText: Slov-Lex subdivision anchors", () => {
  test("narrows to a cited letter and keeps its points", () => {
    expect(extractProvisionText(slovak, "paragraf-36.pismeno-a")).toBe(
      ["a) označenie súdu,", "1. sídlo súdu,"].join("\n"),
    );
    expect(extractProvisionText(slovak, "paragraf-36.pismeno-a.bod-1")).toBe(
      "1. sídlo súdu,",
    );
  });

  test("keeps the whole provision for its heading anchor", () => {
    expect(extractProvisionText(slovak, "paragraf-36")).toContain(
      "b) označenie účastníkov.",
    );
    expect(extractProvisionText(slovak, "paragraf-36")).not.toContain(
      "Ďalšie ustanovenie.",
    );
  });

  test("reads a malformed or foreign-grammar anchor as absent", () => {
    for (const anchor of [
      // A trailing separator names no subdivision.
      "paragraf-36.",
      // A doubled separator holds an empty step.
      "paragraf-36..pismeno-a",
      // e-Sbírka's separator continues no Slov-Lex path.
      "paragraf-36-pismeno-a",
      // A subdivision the provision does not carry.
      "paragraf-36.pismeno-z",
    ]) {
      expect({ anchor, text: extractProvisionText(slovak, anchor) }).toEqual({
        anchor,
        text: null,
      });
    }
  });

  test("reads a Czech anchor in its own grammar only", () => {
    expect(
      extractProvisionText(
        { blocks: czechBlocks, scheme: SLOV_LEX_ANCHORS },
        "par_1729-odst_1",
      ),
    ).toBeNull();
  });
});
