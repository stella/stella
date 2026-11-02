import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Block } from "./document-ast.js";
import { section15LetterBPoint1Blocks } from "./fixtures/sk-595-2003-section-15.js";
import {
  blocksNestedUnder,
  enclosingHeadingAnchor,
  provisionBlocks,
  provisionHeadingAnchor,
  provisionHeadingChain,
  provisionPreviewBlocks,
} from "./provision-preview.js";
import {
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
  US_CODE_ANCHORS,
} from "./statute-anchor-scheme.js";
import type { StatuteAnchorScheme } from "./statute-anchor-scheme.js";

const heading = (
  id: string,
  anchorId: string,
  level: 1 | 2 | 3 | 4 | 5 | 6,
): Block => ({
  anchorId,
  id,
  inlines: [{ text: anchorId, type: "text" }],
  level,
  plainText: anchorId,
  type: "heading",
});

const paragraph = (id: string, anchorId: string, text: string): Block => ({
  anchorId,
  id,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

const readIn = (scheme: StatuteAnchorScheme) => (blocks: readonly Block[]) => ({
  blocks,
  scheme,
});
const czech = readIn(E_SBIRKA_ANCHORS);
const slovak = readIn(SLOV_LEX_ANCHORS);
const us = readIn(US_CODE_ANCHORS);

const blocks: Block[] = [
  heading("h1", "par_1", 2),
  paragraph("p1", "par_1-odst_1", "First paragraph"),
  paragraph("p2", "par_1-odst_1-pism_a", "Cited letter"),
  heading("h2", "par_1-detail", 3),
  paragraph("p3", "par_1-detail-odst_1", "Nested detail"),
  heading("h3", "par_2", 2),
  paragraph("p4", "par_2-odst_1", "Next provision"),
];

describe("provisionPreviewBlocks", () => {
  test("shows only an exactly cited subdivision", () => {
    expect(
      provisionPreviewBlocks(czech(blocks), {
        provisionAnchorId: "par_1",
        citedAnchorId: "par_1-odst_1-pism_a",
      }),
    ).toEqual(blocks.slice(2, 3));
  });

  test("shows the provision body for a provision-level citation", () => {
    expect(
      provisionPreviewBlocks(czech(blocks), {
        provisionAnchorId: "par_1",
        citedAnchorId: undefined,
      }),
    ).toEqual(blocks.slice(1, 5));
  });

  test("keeps the body owned by a cited nested heading", () => {
    expect(
      provisionPreviewBlocks(czech(blocks), {
        provisionAnchorId: "par_1",
        citedAnchorId: "par_1-detail",
      }),
    ).toEqual(blocks.slice(3, 5));
  });

  test("has no wording for an anchor the document does not carry", () => {
    expect(
      provisionPreviewBlocks(czech(blocks), {
        provisionAnchorId: "par_9",
        citedAnchorId: undefined,
      }),
    ).toBeNull();
  });
});

describe("provisionPreviewBlocks over subdivisions", () => {
  // Statute subdivisions are flat paragraphs whose nesting lives in the
  // anchor path, as the corpus stores them.
  const subdivided: Block[] = [
    heading("h", "par_898", 4),
    paragraph("b1", "par_898-odst_1", "(1) First paragraph"),
    paragraph("b2", "par_898-odst_2", "(2) Second paragraph"),
    paragraph("b3", "par_898-odst_2-pism_a", "a) first letter"),
    paragraph("b4", "par_898-odst_2-pism_d", "d) fourth letter"),
    paragraph("b5", "par_898-odst_2-pism_d-bod_1", "1. first point"),
    paragraph("b6", "par_898-odst_2-pism_d-bod_2", "2. second point"),
    paragraph("b7", "par_898-odst_2-pism_e", "e) fifth letter"),
    paragraph("b8", "par_898-odst_20", "(20) A paragraph sharing the prefix"),
    paragraph("b9", "par_898-odst_3", "(3) Third paragraph"),
  ];

  const idsFor = (citedAnchorId: string): string[] | null =>
    provisionPreviewBlocks(czech(subdivided), {
      provisionAnchorId: "par_898",
      citedAnchorId,
    })?.map(({ id }) => id) ?? null;

  test("a cited paragraph keeps its letters and their points", () => {
    expect(idsFor("par_898-odst_2")).toEqual([
      "b2",
      "b3",
      "b4",
      "b5",
      "b6",
      "b7",
    ]);
  });

  test("a cited letter keeps its points", () => {
    expect(idsFor("par_898-odst_2-pism_d")).toEqual(["b4", "b5", "b6"]);
  });

  test("a cited point is shown alone", () => {
    expect(idsFor("par_898-odst_2-pism_d-bod_1")).toEqual(["b5"]);
  });

  test("a cited paragraph does not reach the next paragraph", () => {
    expect(idsFor("par_898-odst_2")).not.toContain("b8");
    expect(idsFor("par_898-odst_2")).not.toContain("b9");
  });

  test("a paragraph does not own one whose number merely extends it", () => {
    expect(idsFor("par_898-odst_20")).toEqual(["b8"]);
  });
});

describe("provisionBlocks", () => {
  test("keeps the heading and every block it owns", () => {
    expect(provisionBlocks(czech(blocks), "par_1")).toEqual(blocks.slice(0, 5));
  });
});

describe("provisionHeadingAnchor", () => {
  test("files a cited subdivision under its provision", () => {
    expect(provisionHeadingAnchor("par_90-odst_5", "-")).toBe("par_90");
    expect(provisionHeadingAnchor("paragraf-5.odsek-1", ".")).toBe(
      "paragraf-5",
    );
    expect(provisionHeadingAnchor("s1983/a/1", "/")).toBe("s1983");
  });

  test("keeps a separator the section number itself carries", () => {
    expect(provisionHeadingAnchor("s2000e-2/a", "/")).toBe("s2000e-2");
  });

  test("leaves a provision-level anchor, and one with no separator, alone", () => {
    expect(provisionHeadingAnchor("par_90", "-")).toBe("par_90");
    expect(provisionHeadingAnchor("par_90-odst_5", null)).toBe("par_90-odst_5");
  });
});

describe("enclosingHeadingAnchor", () => {
  const statute: Block[] = [
    heading("h1", "s2000e-2", 1),
    paragraph("p1", "s2000e-2/a", "s2000e-2/a"),
    paragraph("p2", "s2000e-2/a/1", "s2000e-2/a/1"),
  ];

  test("reads the heading off the document in the publisher's grammar", () => {
    expect(enclosingHeadingAnchor(us(statute), "s2000e-2/a/1")).toBe(
      "s2000e-2",
    );
    expect(
      enclosingHeadingAnchor(
        czech([
          heading("h", "par_90", 1),
          paragraph("p", "par_90-odst_5", "par_90-odst_5"),
        ]),
        "par_90-odst_5",
      ),
    ).toBe("par_90");
  });

  test("a prefix that is not a path step is no heading", () => {
    expect(
      enclosingHeadingAnchor(
        czech([heading("h", "par_9", 1)]),
        "par_90-odst_5",
      ),
    ).toBeNull();
  });
});

describe("blocksNestedUnder with a US path", () => {
  test("a subsection owns its paragraphs and stops at the next subsection", () => {
    const usPath: Block[] = [
      paragraph("a", "s1983/a", "s1983/a"),
      paragraph("a1", "s1983/a/1", "s1983/a/1"),
      paragraph("a1A", "s1983/a/1/A", "s1983/a/1/A"),
      paragraph("b", "s1983/b", "s1983/b"),
    ];
    const cited = usPath[0];
    if (cited === undefined) {
      throw new Error("fixture has no blocks");
    }
    expect(blocksNestedUnder(us(usPath), cited).map(({ id }) => id)).toEqual([
      "a",
      "a1",
      "a1A",
    ]);
  });

  test("a section does not own the next section whose number it opens", () => {
    const sections: Block[] = [
      paragraph("e", "s2000e", "s2000e"),
      paragraph("e2", "s2000e-2", "s2000e-2"),
    ];
    const cited = sections.at(0) ?? panic("fixture has no blocks");
    expect(blocksNestedUnder(us(sections), cited)).toEqual([cited]);
  });
});

describe("provisionPreviewBlocks over Slov-Lex subdivisions", () => {
  // § 15 of 595/2003 Z. z.: a letter whose point holds sub-points, filed
  // under the section as Slov-Lex stores it.
  const section15: Block[] = [
    heading("h", "paragraf-15", 4),
    paragraph("b0", "paragraf-15.pismeno-a", "a) fyzickú osobu"),
    ...section15LetterBPoint1Blocks.map(({ anchorId, id, text }) =>
      paragraph(id, anchorId, text),
    ),
    paragraph("b6", "paragraf-15.pismeno-c", "c) iné"),
  ];

  const idsFor = (citedAnchorId: string): string[] | null =>
    provisionPreviewBlocks(slovak(section15), {
      provisionAnchorId: "paragraf-15",
      citedAnchorId,
    })?.map(({ id }) => id) ?? null;

  test("a cited letter keeps its points and their sub-points", () => {
    expect(idsFor("paragraf-15.pismeno-b")).toEqual([
      "paragraf-15.pismeno-b",
      "paragraf-15.pismeno-b.bod-1",
      "paragraf-15.pismeno-b.bod-1.bod-1a",
      "paragraf-15.pismeno-b.bod-1.bod-1b",
      "paragraf-15.pismeno-b.bod-1.bod-1c",
    ]);
  });

  test("a cited point keeps its sub-points and stops at the next letter", () => {
    expect(idsFor("paragraf-15.pismeno-b.bod-1")).toEqual([
      "paragraf-15.pismeno-b.bod-1",
      "paragraf-15.pismeno-b.bod-1.bod-1a",
      "paragraf-15.pismeno-b.bod-1.bod-1b",
      "paragraf-15.pismeno-b.bod-1.bod-1c",
    ]);
  });

  test("a cited sub-point is shown alone", () => {
    expect(idsFor("paragraf-15.pismeno-b.bod-1.bod-1a")).toEqual([
      "paragraf-15.pismeno-b.bod-1.bod-1a",
    ]);
  });

  test("the subdivision's own heading is found in the publisher's grammar", () => {
    expect(
      enclosingHeadingAnchor(slovak(section15), "paragraf-15.pismeno-b.bod-1"),
    ).toBe("paragraf-15");
    // Read in e-Sbírka's grammar the letter continues no heading.
    expect(
      enclosingHeadingAnchor(czech(section15), "paragraf-15.pismeno-b.bod-1"),
    ).toBeNull();
  });
});

describe("provisionHeadingChain", () => {
  const nested: Block[] = [
    heading("c1", "cast_4", 1),
    heading("c2", "hlava_1", 2),
    paragraph("c3", "hlava_1-intro", "Division opening"),
    heading("c4", "dil_2", 3),
    heading("c5", "par_1729", 4),
    paragraph("c6", "par_1729-odst_1", "Provision text"),
    heading("c7", "cast_5", 1),
    heading("c8", "par_2000", 4),
  ];

  test("lists the enclosing headings outermost first", () => {
    expect(
      provisionHeadingChain(czech(nested), "par_1729")?.map(
        ({ anchorId }) => anchorId,
      ),
    ).toEqual(["cast_4", "hlava_1", "dil_2"]);
  });

  test("stops at the heading that encloses the provision", () => {
    expect(
      provisionHeadingChain(czech(nested), "par_2000")?.map(
        ({ anchorId }) => anchorId,
      ),
    ).toEqual(["cast_5"]);
  });

  test("has no chain for an anchor the document does not carry", () => {
    expect(provisionHeadingChain(czech(nested), "par_9")).toBeNull();
  });
});
