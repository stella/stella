import { describe, expect, test } from "bun:test";

import type { ParagraphBlock } from "../types";
import {
  fixedCharWidth,
  withFakeTextMeasure,
} from "./__tests__/fakeTextMeasure";
import {
  DEFAULT_TAB_STOP_TWIPS,
  getListMarkerInlineWidth,
} from "./listMarkerWidth";

const DEFAULT_TAB_STOP_PX = (DEFAULT_TAB_STOP_TWIPS / 1440) * 96;

const fakeMeasure = { charWidth: fixedCharWidth(10) };

function listBlock(overrides: ParagraphBlock["attrs"]): ParagraphBlock {
  return {
    kind: "paragraph",
    id: "p",
    runs: [{ kind: "text", text: "body" }],
    attrs: { defaultFontSize: 11, defaultFontFamily: "Calibri", ...overrides },
  };
}

describe("getListMarkerInlineWidth", () => {
  test("no marker → 0", () => {
    withFakeTextMeasure(() => {
      expect(getListMarkerInlineWidth(listBlock({}))).toBe(0);
    }, fakeMeasure);
  });

  test("hidden marker → 0", () => {
    withFakeTextMeasure(() => {
      expect(
        getListMarkerInlineWidth(
          listBlock({ listMarker: "1.", listMarkerHidden: true }),
        ),
      ).toBe(0);
    }, fakeMeasure);
  });

  test("hanging indent: width equals hanging slot", () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
          indent: { left: 60, hanging: 36 },
        }),
      );
      expect(width).toBe(36);
    }, fakeMeasure);
  });

  test('w:suff="nothing" → exactly natural marker width', () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
          listMarkerSuffix: "nothing",
        }),
      );
      // Natural width = 2 chars * 10 = 20.
      expect(width).toBe(20);
    }, fakeMeasure);
  });

  test('w:suff="space" → natural + one space glyph', () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
          listMarkerSuffix: "space",
        }),
      );
      // 2 chars + 1 space char = 30.
      expect(width).toBe(30);
    }, fakeMeasure);
  });

  // Regression for upstream #600: a long marker like "1.1.1." must grow to
  // the next default-grid tab stop so body text aligns past it. Folio's
  // previous behavior used a fixed +12 px gap which broke alignment.
  test('default suff="tab": long marker aligns body at next default-grid stop', () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.1.1.",
        }),
      );
      // Natural width = 6 chars * 10 = 60. With markerStartPx=0 and a 48 px
      // default grid, minBodyStart = 60 → next grid is floor(60/48)+1 = 2 →
      // bodyStart = 96 px. So marker = 96 - 0 = 96.
      const expectedGrid = Math.floor(60 / DEFAULT_TAB_STOP_PX) + 1;
      const expectedBodyStart = expectedGrid * DEFAULT_TAB_STOP_PX;
      expect(width).toBeCloseTo(expectedBodyStart, 5);
    }, fakeMeasure);
  });

  test('short marker still aligns body at next default-grid stop with suff="tab"', () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
        }),
      );
      // Natural width = 20. minBodyStart=20. Next grid = floor(20/48)+1=1
      // → bodyStart = 48. Marker = 48.
      expect(width).toBeCloseTo(DEFAULT_TAB_STOP_PX, 5);
    }, fakeMeasure);
  });

  test("custom tab stop closer than default grid wins", () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
          // 360 twips = 24 px; this is past natural width (20), so it wins
          // over the default-grid stop at 48 px.
          tabs: [{ val: "start", pos: 360 }],
        }),
      );
      expect(width).toBeCloseTo(24, 5);
    }, fakeMeasure);
  });

  test("tab stops marked `clear` or `bar` are ignored", () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
          tabs: [
            { val: "clear", pos: 360 },
            { val: "bar", pos: 480 },
          ],
        }),
      );
      // Both ignored → falls back to the default-grid stop at 48 px.
      expect(width).toBeCloseTo(DEFAULT_TAB_STOP_PX, 5);
    }, fakeMeasure);
  });

  test("custom defaultTabStopTwips on the block overrides the OOXML default grid", () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
          // 1440 twips = 96 px (1 inch grid, as Word renders some templates).
          defaultTabStopTwips: 1440,
        }),
      );
      // Natural width = 20; next 96 px stop is 96. Marker width = 96.
      expect(width).toBeCloseTo(96, 5);
    }, fakeMeasure);
  });

  // Regression for bot review #460: when the marker overflows the hanging
  // slot, Word advances body text to the next tab stop instead of letting
  // body collide with the marker. Previously folio returned `hanging`
  // unconditionally, which produced overlap for long markers like
  // "1.1.1.1." inside a 36 px hanging slot.
  test("hanging-indent marker that overflows the slot advances to next tab stop", () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.1.1.1.",
          indent: { left: 60, hanging: 36 },
        }),
      );
      // Natural width = 8 chars * 10 = 80. markerStart = 60-36 = 24.
      // minBodyStart = 24+80 = 104. Hanging is consumed → search past
      // indentLeft=60. Next default-grid stop past max(104,60)=104 is
      // ceil(104/48)*48 = 144. marker = 144 - 24 = 120.
      const expectedBodyStart =
        Math.ceil(104 / DEFAULT_TAB_STOP_PX) * DEFAULT_TAB_STOP_PX;
      expect(width).toBeCloseTo(expectedBodyStart - 24, 5);
    }, fakeMeasure);
  });

  // Regression for bot review #460 (codex): when `minBodyStart` lands
  // exactly on a default-grid stop, the old `Math.floor(...)+1` rolled
  // forward by a full tab interval. The surrounding comment already
  // states equality must be preserved (§17.9.27); fix the default-grid
  // arithmetic to match.
  test("default-grid stop landing exactly on minBodyStart is used as-is", () => {
    withFakeTextMeasure(() => {
      // Marker "12345" with default font: 5 chars * 10 = 50 px — exceeds
      // 48 px so it doesn't land exactly. Use a 24 px firstLine to push
      // markerStart to 24, so minBodyStart = 24 + 24 (natural for "12.")
      // = 48 EXACTLY on the default grid.
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "12.",
          // 480 twips = 32 px; markerStart shifts by 16 px (~ish). Use
          // a clean firstLine = 18 px in twips (270) → markerStart=18,
          // natural=30, minBodyStart=48 EXACTLY.
          indent: { left: 0, firstLine: 18 },
        }),
      );
      // minBodyStart = 18 + 30 = 48 = default-grid stop exactly.
      // bodyStart MUST be 48, not 96. marker = 48 - 18 = 30.
      expect(width).toBeCloseTo(DEFAULT_TAB_STOP_PX - 18, 5);
    }, fakeMeasure);
  });

  test("first-line indent shifts marker start: bodyStart adjusts", () => {
    withFakeTextMeasure(() => {
      const width = getListMarkerInlineWidth(
        listBlock({
          listMarker: "1.",
          indent: { left: 0, firstLine: 24 },
        }),
      );
      // markerStartPx = 24. Natural width = 20 → minBodyStart = 44.
      // Next default-grid stop past 44 is 48. marker = 48 - 24 = 24.
      expect(width).toBeCloseTo(DEFAULT_TAB_STOP_PX - 24, 5);
    }, fakeMeasure);
  });
});
