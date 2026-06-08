/**
 * Golden layout integration test.
 *
 * Unlike layout-pipeline.integration.test.ts (which feeds hand-authored
 * `measures` straight into `layoutDocument`), this exercises the real
 * measurement seam: representative FlowBlocks -> `measureBlocks` -> real
 * `Measure[]` -> `layoutDocument` -> asserted page geometry. Running under the
 * shared deterministic text-measure harness makes the produced geometry
 * reproducible, so the assertions below lock pagination behaviour (page
 * mapping, vertical stacking, table integrity, no content loss) against silent
 * regressions in either the measurer or the paginator.
 */

import { describe, expect, test } from "bun:test";

import { layoutDocument } from "../layout-engine/index";
import {
  fixedCharWidth,
  withFakeTextMeasure,
} from "../layout-engine/measure/__tests__/fakeTextMeasure";
import { measureBlocks } from "../layout-engine/measure/measureBlocks";
import type {
  FlowBlock,
  LayoutOptions,
  PageMargins,
  ParagraphBlock,
  TableBlock,
} from "../layout-engine/types";

const fakeMeasure = { charWidth: fixedCharWidth(5) };

const PAGE_SIZE = { w: 816, h: 1056 }; // US Letter at 96 DPI
const MARGINS: PageMargins = { top: 96, right: 96, bottom: 96, left: 96 };
const CONTENT_WIDTH = PAGE_SIZE.w - MARGINS.left - MARGINS.right; // 624

const LAYOUT_OPTIONS: LayoutOptions = {
  pageSize: PAGE_SIZE,
  margins: MARGINS,
  pageGap: 20,
};

const para = (id: string, text: string): ParagraphBlock => ({
  kind: "paragraph",
  id,
  runs: [{ kind: "text", text }],
});

const table = (id: string, rowTexts: string[]): TableBlock => ({
  kind: "table",
  id,
  columnWidths: [200],
  rows: rowTexts.map((text, rowIdx) => ({
    id: `${id}-r${rowIdx}`,
    cells: [
      {
        id: `${id}-r${rowIdx}-c0`,
        blocks: [para(`${id}-r${rowIdx}-c0-p`, text)],
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      },
    ],
  })),
});

const pageBreak = (id: string): FlowBlock => ({ kind: "pageBreak", id });

function layoutOf(blocks: FlowBlock[]) {
  const measures = measureBlocks(blocks, CONTENT_WIDTH);
  expect(measures).toHaveLength(blocks.length);
  return layoutDocument(blocks, measures, LAYOUT_OPTIONS);
}

describe("golden layout: measure -> paginate", () => {
  test("explicit page break splits content onto two pages, no block lost", () => {
    withFakeTextMeasure(() => {
      const blocks: FlowBlock[] = [
        para("title", "Agreement"),
        para("body-1", "First clause of the agreement."),
        table("schedule", ["Row one", "Row two", "Row three"]),
        para("body-2", "Second clause before the break."),
        pageBreak("brk"),
        para("after", "Clause that must start on page two."),
      ];

      const layout = layoutOf(blocks);

      // Two pages: everything before the break, then the trailing paragraph.
      expect(layout.pages).toHaveLength(2);

      const idsOn = (pageIndex: number) =>
        layout.pages[pageIndex]!.fragments.map((f) => f.blockId);

      expect(idsOn(0)).toEqual(["title", "body-1", "schedule", "body-2"]);
      expect(idsOn(1)).toEqual(["after"]);

      // The page-break block itself produces no fragment, and every other
      // block produces exactly one fragment across all pages, order preserved.
      const allFragmentIds = layout.pages.flatMap((p) =>
        p.fragments.map((f) => f.blockId),
      );
      expect(allFragmentIds).toEqual([
        "title",
        "body-1",
        "schedule",
        "body-2",
        "after",
      ]);
    }, fakeMeasure);
  });

  test("fragments stack vertically from the top margin", () => {
    withFakeTextMeasure(() => {
      const blocks: FlowBlock[] = [
        para("a", "Alpha paragraph."),
        para("b", "Beta paragraph."),
        para("c", "Gamma paragraph."),
      ];

      const layout = layoutOf(blocks);
      expect(layout.pages).toHaveLength(1);

      const frags = layout.pages[0]!.fragments;
      expect(frags).toHaveLength(3);

      // First fragment sits exactly at the top margin; the rest descend
      // strictly, each below the previous (no overlap, correct order).
      expect(frags[0]!.y).toBe(MARGINS.top);
      for (let i = 1; i < frags.length; i++) {
        expect(frags[i]!.y).toBeGreaterThan(frags[i - 1]!.y);
      }
    }, fakeMeasure);
  });

  test("a multi-row table lays out as one fragment spanning all its rows", () => {
    withFakeTextMeasure(() => {
      const blocks: FlowBlock[] = [
        para("intro", "See schedule below."),
        table("t", ["One", "Two", "Three", "Four"]),
      ];

      const layout = layoutOf(blocks);
      expect(layout.pages).toHaveLength(1);

      const tableFragment = layout.pages[0]!.fragments.find(
        (f) => f.blockId === "t",
      );
      expect(tableFragment?.kind).toBe("table");
      if (tableFragment?.kind === "table") {
        expect(tableFragment.fromRow).toBe(0);
        expect(tableFragment.toRow).toBe(4);
        // The table is positioned below the intro paragraph.
        const intro = layout.pages[0]!.fragments.find(
          (f) => f.blockId === "intro",
        );
        expect(tableFragment.y).toBeGreaterThan(intro!.y);
      }
    }, fakeMeasure);
  });
});
