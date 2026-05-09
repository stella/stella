import { describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import type {
  FlowBlock,
  LayoutOptions,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  PageMargins,
  TextRun,
} from "./types";

// Regression: when a paragraph is split across pages and the
// footnote ref lives in a continuation fragment, the fn must be
// attributed to the page where the ref-bearing *line* actually
// landed — not to the page hosting the first fragment of the
// paragraph.
//
// Pre-fix the engine reserved space correctly per line, but the
// post-layout `mapFootnotesToPages` looked at fragment-level
// pmStart/pmEnd. Both halves of a split paragraph carry the full
// paragraph span, so a ref in the second half could be reported as
// belonging to the first half's page (Codex PR #258 review).

const MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

function textRun(
  pmStart: number,
  text: string,
  footnoteRefId?: number,
): TextRun {
  const run: TextRun = {
    kind: "text",
    text,
    pmStart,
    pmEnd: pmStart + text.length,
  };
  if (footnoteRefId !== undefined) {
    run.footnoteRefId = footnoteRefId;
  }
  return run;
}

function makeMultiLinePara(
  id: number,
  lineCount: number,
  lineHeight: number,
  fnRefAtLineIndex: number,
  fnId: number,
): { block: ParagraphBlock; measure: ParagraphMeasure } {
  // One run per line so the per-line `[fromRun..toRun]` mapping is
  // trivial; the fn ref sits on the run for `fnRefAtLineIndex`.
  const runs: TextRun[] = Array.from({ length: lineCount }, (_, i) =>
    textRun(1 + i * 10, `line${i}`, i === fnRefAtLineIndex ? fnId : undefined),
  );
  const block: ParagraphBlock = {
    kind: "paragraph",
    id,
    runs,
    attrs: {},
    pmStart: 1,
    pmEnd: 1 + lineCount * 10,
  };
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    fromRun: i,
    fromChar: 0,
    toRun: i,
    toChar: 0,
    width: 100,
    ascent: lineHeight * 0.8,
    descent: lineHeight * 0.2,
    lineHeight,
  }));
  const measure: ParagraphMeasure = {
    kind: "paragraph",
    lines,
    totalHeight: lineHeight * lineCount,
  };
  return { block, measure };
}

describe("footnote routing across split paragraphs", () => {
  test("fn ref in continuation fragment is attributed to its host page", () => {
    // Page content area = 50 px, line height = 10. A 10-line paragraph
    // splits 5 lines on page 1, 5 lines on page 2. Put the fn ref on
    // line index 7 (second half) — it should land on page 2, not on
    // page 1. The fn content height is 30 px, comfortably fitting
    // alongside lines 5-9 on page 2 (50 - 30 = 20 px slack).
    const { block, measure } = makeMultiLinePara(0, 10, 10, 7, 99);

    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 50 },
      margins: MARGINS,
      pageGap: 0,
      footnoteHeightById: new Map([[99, 30]]),
    };

    const layout = layoutDocument(
      [block as FlowBlock],
      [measure as Measure],
      layoutOptions,
    );

    expect(layout.pages.length).toBeGreaterThanOrEqual(2);
    // Page 1 should NOT have fn 99 attributed to it.
    const p1Ids = layout.pages[0]!.footnoteIds ?? [];
    expect(p1Ids).not.toContain(99);
    // Page 2 (or wherever the ref-bearing line actually landed) is
    // the host page; assert fn 99 is attributed there.
    const hostPage = layout.pages.find((p) =>
      (p.footnoteIds ?? []).includes(99),
    );
    expect(hostPage).toBeDefined();
    expect(hostPage!.number).toBeGreaterThanOrEqual(2);
  });

  test("fn ref in first fragment is attributed to page 1", () => {
    // Sanity: ref on line 1 (first half) → page 1.
    const { block, measure } = makeMultiLinePara(0, 10, 10, 1, 42);

    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 60 },
      margins: MARGINS,
      pageGap: 0,
      footnoteHeightById: new Map([[42, 20]]),
    };

    const layout = layoutDocument(
      [block as FlowBlock],
      [measure as Measure],
      layoutOptions,
    );
    expect(layout.pages[0]!.footnoteIds).toContain(42);
  });
});
