import { describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import type {
  FlowBlock,
  LayoutOptions,
  Measure,
  ParagraphAttrs,
  ParagraphBlock,
  ParagraphMeasure,
  PageMargins,
} from "./types";

// Issue #402 (eigenpal): Word collapses style-inherited spacing on empty
// paragraphs (only direct `<w:pPr><w:spacing>` formatting survives). The
// engine consults `attrs.spacingExplicit` to distinguish: if the field for
// `before`/`after` is falsy, an empty paragraph carries no spacing on that
// side regardless of what the inherited style would have set.

const PAGE_SIZE = { w: 600, h: 1200 };
const MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

function makePara(
  id: number,
  text: string,
  attrs: ParagraphAttrs,
): ParagraphBlock {
  return {
    kind: "paragraph",
    id,
    runs: [{ kind: "text", text, pmStart: 1, pmEnd: 1 + text.length }],
    attrs,
    pmStart: 1,
    pmEnd: 1 + text.length + 1,
  };
}

function makeMeasure(lineHeight: number): ParagraphMeasure {
  return {
    kind: "paragraph",
    lines: [
      {
        fromRun: 0,
        fromChar: 0,
        toRun: 0,
        toChar: 0,
        width: 100,
        ascent: lineHeight * 0.8,
        descent: lineHeight * 0.2,
        lineHeight,
      },
    ],
    totalHeight: lineHeight,
  };
}

const layoutOptions: LayoutOptions = {
  pageSize: PAGE_SIZE,
  margins: MARGINS,
  pageGap: 20,
};

describe("empty-paragraph spacing collapse (issue #402)", () => {
  test("inherited spacing on an empty paragraph does not push the next paragraph", () => {
    // Empty paragraph with style-inherited before:80, after:80 (no
    // spacingExplicit). The engine zeroes both sides for this one only.
    const blocks: FlowBlock[] = [
      makePara(0, "Heading", { spacing: { after: 0 } }),
      // Empty paragraph — runs is a single empty TextRun. spacingExplicit absent.
      makePara(1, "", { spacing: { before: 80, after: 80 } }),
      makePara(2, "Body", { spacing: { before: 0 } }),
    ];
    const measures: Measure[] = [
      makeMeasure(16),
      makeMeasure(16),
      makeMeasure(16),
    ];

    const layout = layoutDocument(blocks, measures, layoutOptions);
    const fragments = layout.pages[0]!.fragments;
    expect(fragments).toHaveLength(3);

    // p0: y=0; p1: y=16 (no inherited before applied); p2: y=32 (no
    // inherited after carried forward by p1).
    expect(fragments[0]!.y).toBe(0);
    expect(fragments[1]!.y).toBe(16);
    expect(fragments[2]!.y).toBe(32);
  });

  test("explicit inline spacing on an empty paragraph IS honored", () => {
    // The user authored <w:p><w:pPr><w:spacing w:before="80"/></w:pPr></w:p>
    // (typed a blank line with explicit spacing). spacingExplicit.before=true,
    // so the value survives the empty-paragraph collapse.
    const blocks: FlowBlock[] = [
      makePara(0, "Heading", { spacing: { after: 0 } }),
      makePara(1, "", {
        spacing: { before: 80, after: 0 },
        spacingExplicit: { before: true },
      }),
      makePara(2, "Body", { spacing: { before: 0 } }),
    ];
    const measures: Measure[] = [
      makeMeasure(16),
      makeMeasure(16),
      makeMeasure(16),
    ];

    const layout = layoutDocument(blocks, measures, layoutOptions);
    const fragments = layout.pages[0]!.fragments;

    // p1's explicit before:80 honored, so p1 starts at y=16+80=96 and
    // p2 follows at y=96+16=112.
    expect(fragments[1]!.y).toBe(96);
    expect(fragments[2]!.y).toBe(112);
  });

  test("non-empty paragraphs always carry their inherited spacing", () => {
    // Sanity: the collapse only applies to empty paragraphs.
    const blocks: FlowBlock[] = [
      makePara(0, "Heading", { spacing: { after: 0 } }),
      makePara(1, "Body line", { spacing: { before: 80, after: 0 } }),
    ];
    const measures: Measure[] = [makeMeasure(16), makeMeasure(16)];

    const layout = layoutDocument(blocks, measures, layoutOptions);
    const fragments = layout.pages[0]!.fragments;

    // p1 has visible content, so its inherited before:80 applies.
    expect(fragments[1]!.y).toBe(96);
  });
});
