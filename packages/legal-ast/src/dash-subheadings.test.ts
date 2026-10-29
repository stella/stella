import { describe, expect, test } from "bun:test";

import { withDashSubheadingLevels } from "./dash-subheadings.js";
import type { Block, HeadingLevel } from "./document-ast.js";
import { headingPathsByAnchor } from "./heading-path.js";

const heading = (id: string, level: HeadingLevel, text: string): Block => ({
  type: "heading",
  id,
  anchorId: id,
  level,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const paragraph = (id: string): Block => ({
  type: "paragraph",
  id,
  anchorId: id,
  inlines: [{ type: "text", text: "Text." }],
  plainText: "Text.",
});

/**
 * The shape the published corpus holds for a Court of Justice appeal
 * (C-602/22 P, every language): each ground's dash-led subheadings stored at
 * the ground's own level, so all of them read as children of "Substance".
 */
const APPEAL: Block[] = [
  heading("appeal", 2, "The appeal"),
  heading("admissibility", 3, "Admissibility of the appeal"),
  heading("admissibility-arguments", 4, "Arguments of the parties"),
  paragraph("p-42"),
  heading("substance", 3, "Substance"),
  heading("ground-1", 4, "The first ground of appeal"),
  heading("ground-1-arguments", 4, "– Arguments of the parties"),
  paragraph("p-50"),
  heading("ground-1-findings", 4, "– Findings of the Court"),
  paragraph("p-68"),
  heading("ground-2", 4, "The second ground of appeal"),
  heading("ground-2-arguments", 4, "– Arguments of the parties"),
  paragraph("p-120"),
  heading("ground-2-findings", 4, "– Findings of the Court"),
  paragraph("p-130"),
  heading("costs", 2, "Costs"),
];

const parentTitle = (blocks: readonly Block[], anchorId: string) =>
  headingPathsByAnchor(blocks).get(anchorId)?.at(-1)?.title;

describe("subheadings a publisher marks with a dash", () => {
  test("stored flat, each one reads as a child of the section, not of its ground", () => {
    // The control: the stored levels place both copies under "Substance".
    expect(parentTitle(APPEAL, "ground-1-arguments")).toBe("Substance");
    expect(parentTitle(APPEAL, "ground-2-arguments")).toBe("Substance");
  });

  test("the reader nests each one under the ground it answers", () => {
    const nested = withDashSubheadingLevels(APPEAL);
    expect(parentTitle(nested, "ground-1-arguments")).toBe(
      "The first ground of appeal",
    );
    expect(parentTitle(nested, "ground-1-findings")).toBe(
      "The first ground of appeal",
    );
    expect(parentTitle(nested, "ground-2-arguments")).toBe(
      "The second ground of appeal",
    );
    // A heading after the subheadings returns to its own place.
    expect(parentTitle(nested, "ground-2")).toBe("Substance");
    expect(parentTitle(nested, "costs")).toBeUndefined();
  });

  test("only dash-led headings change, and only their level", () => {
    const nested = withDashSubheadingLevels(APPEAL);
    for (const [index, block] of nested.entries()) {
      const stored = APPEAL[index];
      if (stored?.type === "heading" && block.type === "heading") {
        expect({ ...block, level: stored.level }).toEqual(stored);
        if (!stored.plainText.startsWith("–")) {
          expect(block).toBe(stored);
        }
      } else {
        expect(block).toBe(stored);
      }
    }
  });

  test("a dash-led heading already below its parent keeps its level", () => {
    const blocks = [
      heading("ground", 3, "The first ground of appeal"),
      heading("arguments", 5, "– Arguments of the parties"),
    ];
    expect(withDashSubheadingLevels(blocks)).toEqual(blocks);
  });
});
