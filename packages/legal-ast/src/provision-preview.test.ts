import { describe, expect, test } from "bun:test";

import type { Block } from "./document-ast.js";
import {
  provisionBlocks,
  provisionHeadingAnchor,
  provisionHeadingChain,
  provisionPreviewBlocks,
} from "./provision-preview.js";

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
      provisionPreviewBlocks(blocks, "par_1", "par_1-odst_1-pism_a"),
    ).toEqual(blocks.slice(2, 3));
  });

  test("shows the provision body for a provision-level citation", () => {
    expect(provisionPreviewBlocks(blocks, "par_1", undefined)).toEqual(
      blocks.slice(1, 5),
    );
  });

  test("keeps the body owned by a cited nested heading", () => {
    expect(provisionPreviewBlocks(blocks, "par_1", "par_1-detail")).toEqual(
      blocks.slice(3, 5),
    );
  });

  test("has no wording for an anchor the document does not carry", () => {
    expect(provisionPreviewBlocks(blocks, "par_9", undefined)).toBeNull();
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
    provisionPreviewBlocks(subdivided, "par_898", citedAnchorId)?.map(
      ({ id }) => id,
    ) ?? null;

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
    expect(provisionBlocks(blocks, "par_1")).toEqual(blocks.slice(0, 5));
  });
});

describe("provisionHeadingAnchor", () => {
  test("files a cited subdivision under its provision", () => {
    expect(provisionHeadingAnchor("par_90-odst_5")).toBe("par_90");
  });

  test("leaves a provision-level anchor alone", () => {
    expect(provisionHeadingAnchor("par_90")).toBe("par_90");
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
      provisionHeadingChain(nested, "par_1729")?.map(
        ({ anchorId }) => anchorId,
      ),
    ).toEqual(["cast_4", "hlava_1", "dil_2"]);
  });

  test("stops at the heading that encloses the provision", () => {
    expect(
      provisionHeadingChain(nested, "par_2000")?.map(
        ({ anchorId }) => anchorId,
      ),
    ).toEqual(["cast_5"]);
  });

  test("has no chain for an anchor the document does not carry", () => {
    expect(provisionHeadingChain(nested, "par_9")).toBeNull();
  });
});
