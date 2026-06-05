/**
 * Contextual spacing must be applied inside table cells too, not only at the
 * top level of the document. Without recursion into cells, two same-style
 * paragraphs in a cell keep their before/after spacing, so the measured cell
 * height diverges from what the painter renders. Regression for
 * eigenpal/docx-editor#699.
 */

import { describe, expect, test } from "bun:test";

import { applyContextualSpacing } from "./index";
import type { FlowBlock, ParagraphBlock, TableBlock } from "./types";

function bullet(id: string, styleId: string): ParagraphBlock {
  return {
    kind: "paragraph",
    id,
    runs: [{ kind: "text", text: id }],
    attrs: {
      spacing: { before: 5, after: 13 },
      contextualSpacing: true,
      styleId,
    },
  };
}

function tableWith(...paragraphs: ParagraphBlock[]): TableBlock {
  return {
    kind: "table",
    id: "t",
    rows: [{ id: "r", cells: [{ id: "c", blocks: paragraphs }] }],
  };
}

describe("applyContextualSpacing in table cells", () => {
  test("suppresses spacing between same-style contextual paragraphs in a cell", () => {
    const a = bullet("a", "ListBullet");
    const b = bullet("b", "ListBullet");
    const blocks: FlowBlock[] = [tableWith(a, b)];

    applyContextualSpacing(blocks);

    expect(a.attrs?.spacing?.after).toBe(0);
    expect(b.attrs?.spacing?.before).toBe(0);
  });

  test("does not suppress spacing across differing styles in a cell", () => {
    const a = bullet("a", "ListBullet");
    const b = bullet("b", "Normal");
    const blocks: FlowBlock[] = [tableWith(a, b)];

    applyContextualSpacing(blocks);

    expect(a.attrs?.spacing?.after).toBe(13);
    expect(b.attrs?.spacing?.before).toBe(5);
  });
});
