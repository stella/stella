import { describe, expect, test } from "bun:test";

import type { FlowBlock, ParagraphBlock } from "../core/layout-engine/types";
import { computePerBlockWidths } from "./sectionBlockWidths";

const BODY_CONFIG = {
  pageSize: { w: 1000, h: 1200 },
  margins: { top: 50, right: 100, bottom: 50, left: 100 },
};

function paragraph(id: string): ParagraphBlock {
  return {
    kind: "paragraph",
    id,
    runs: [{ kind: "text", text: id }],
    attrs: {},
  };
}

describe("computePerBlockWidths", () => {
  test("uses each section's page size and margins for measurement width", () => {
    const blocks: FlowBlock[] = [
      paragraph("first-section"),
      {
        kind: "sectionBreak",
        id: "section-one",
        pageSize: { w: 600, h: 1200 },
        margins: { top: 50, right: 50, bottom: 50, left: 50 },
      },
      paragraph("final-section"),
    ];

    const widths = computePerBlockWidths({
      blocks,
      bodyConfig: BODY_CONFIG,
      finalConfig: BODY_CONFIG,
    });

    expect(widths).toEqual([500, 500, 800]);
  });
});
