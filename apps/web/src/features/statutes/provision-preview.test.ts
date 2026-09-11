import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { provisionPreviewBlocks } from "./provision-preview";

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
});
