/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it } from "bun:test";

import type { CharSpan, MeasureWidthFn } from "./pdf-coords";
import { getEntityBBoxes } from "./pdf-coords";

// ── Helpers ────────────────────────────────────────────

/** Per-character widths simulating a proportional font. */
const CHAR_WIDTHS: Record<string, number> = {
  " ": 3,
  ".": 3,
  ",": 3,
  ":": 3,
  "/": 4,
  "0": 6,
  "1": 5,
  "2": 6,
  "3": 6,
  "4": 6,
  "5": 6,
  "8": 6,
  a: 6,
  á: 6,
  B: 8,
  c: 5,
  č: 5,
  d: 6,
  e: 6,
  h: 6,
  i: 3,
  I: 4,
  K: 7,
  k: 6,
  l: 3,
  m: 9,
  n: 6,
  N: 8,
  o: 6,
  P: 7,
  p: 6,
  r: 4,
  s: 5,
  S: 7,
  t: 4,
  Č: 7,
  í: 3,
  Ě: 7,
};

const charWidth = (ch: string): number => CHAR_WIDTHS[ch] ?? 6;

const stringWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) {
    w += charWidth(ch);
  }
  return w;
};

/**
 * Mock measureWidth that uses CHAR_WIDTHS lookup.
 * Ignores cssFont (tests use a single simulated font).
 */
const mockMeasure: MeasureWidthFn = (_font, text) => stringWidth(text);

/** Build a CharSpan for testing. */
const span = (
  start: number,
  text: string,
  x: number,
  pdfWidth: number,
): CharSpan => ({
  start,
  end: start + text.length,
  text,
  cssFont: "12px serif",
  bbox: {
    pageIndex: 0,
    x,
    y: 700,
    width: pdfWidth,
    height: 12,
    fontSize: 12,
  },
});

// ── Tests ──────────────────────────────────────────────

describe("getEntityBBoxes()", () => {
  it("returns nothing for non-overlapping entity", () => {
    const spans: CharSpan[] = [span(0, "Hello World", 50, 100)];
    const result = getEntityBBoxes(spans, 20, 30, mockMeasure);
    expect(result).toHaveLength(0);
  });

  it("returns exact bbox when entity fully covers span", () => {
    const s = span(10, "Praha 10", 50, 60);
    const result = getEntityBBoxes([s], 10, 18, mockMeasure);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(50);
    expect(result[0].width).toBe(60);
  });

  it("computes sub-rect for entity in middle of span", () => {
    // "se sídlem Praha 10, Bohdalecká"
    // Entity: "Praha 10" starts at local index 10
    const text = "se sídlem Praha 10, Bohdalecká";
    const measuredTotal = stringWidth(text);
    // PDF width differs from measured (simulates scaling)
    const pdfWidth = measuredTotal * 1.2;
    const s = span(0, text, 50, pdfWidth);

    const entityText = "Praha 10";
    const entityStart = text.indexOf(entityText);
    const entityEnd = entityStart + entityText.length;

    const result = getEntityBBoxes([s], entityStart, entityEnd, mockMeasure);

    expect(result).toHaveLength(1);
    const bbox = result[0];

    // Verify the bbox covers the entity region
    // (with padding, so it extends beyond the exact chars)
    const scale = pdfWidth / measuredTotal;
    const prefix = text.slice(0, entityStart);
    const expectedPrefixWidth = stringWidth(prefix) * scale;
    const expectedEntityWidth = stringWidth(entityText) * scale;
    const pad = 12 * 0.75; // fontSize * 0.5

    // Left edge should be at prefix - padding
    expect(bbox.x).toBeCloseTo(50 + expectedPrefixWidth - pad, 1);
    // Width should be entity width + 2 * padding
    expect(bbox.width).toBeCloseTo(expectedEntityWidth + 2 * pad, 1);
  });

  it("clamps sub-rect to span boundaries", () => {
    // Entity overlaps the very start of the span
    const text = "Praha 10, Bohdalecká";
    const pdfWidth = stringWidth(text);
    const s = span(0, text, 50, pdfWidth);

    // Entity covers "Praha 10" (first 8 chars)
    const result = getEntityBBoxes([s], 0, 8, mockMeasure);

    expect(result).toHaveLength(1);
    // Left edge should be clamped to span.bbox.x (50)
    // since padding would push it before the span start
    expect(result[0].x).toBe(50);
  });

  it("handles entity spanning multiple spans", () => {
    // Two adjacent TextItems
    const s1 = span(0, "Praha 10,", 50, 60);
    const s2 = span(10, "Bohdalecká 1490/25", 115, 120);

    // Entity covers "Praha 10, Bohdalecká"
    const result = getEntityBBoxes([s1, s2], 0, 20, mockMeasure);

    // Should return bboxes for both spans
    expect(result).toHaveLength(2);
    // First span is fully covered → exact bbox
    expect(result[0].x).toBe(50);
    expect(result[0].width).toBe(60);
  });

  it("scales measured widths to match PDF metrics", () => {
    // PDF width is 1.3x what browser measures
    // (simulates embedded font with wider glyphs,
    // within the 1.5x cap)
    const text = "IČO: 03114988";
    const measuredWidth = stringWidth(text);
    const pdfWidth = measuredWidth * 1.3;
    const s = span(0, text, 100, pdfWidth);

    // Entity covers "03114988" (index 5..13)
    const result = getEntityBBoxes([s], 5, 13, mockMeasure);

    expect(result).toHaveLength(1);
    const bbox = result[0];

    const scale = 1.3;
    const prefixMeasured = stringWidth("IČO: ");
    const entityMeasured = stringWidth("03114988");
    const pad = 12 * 0.75;

    const expectedX = 100 + prefixMeasured * scale - pad;
    const expectedEnd = Math.min(
      100 + pdfWidth,
      100 + (prefixMeasured + entityMeasured) * scale + pad,
    );

    expect(bbox.x).toBeCloseTo(expectedX, 1);
    expect(bbox.width).toBeCloseTo(expectedEnd - expectedX, 1);
  });

  it("uses raw scale for sub-TextItem positions in table-layout", () => {
    // PDF width is 3x measured (table gap inflation).
    // Sub-TextItem positions use the raw (uncapped) scale
    // so the ratio-based mapping places the box at the
    // correct proportional position within the TextItem.
    const text = "IČO: 03114988";
    const measuredWidth = stringWidth(text);
    const pdfWidth = measuredWidth * 3;
    const s = span(0, text, 100, pdfWidth);

    const result = getEntityBBoxes([s], 5, 13, mockMeasure);

    expect(result).toHaveLength(1);
    const bbox = result[0];

    // Positions use rawScale (3x) for correct mapping
    const rawScale = 3;
    const prefixMeasured = stringWidth("IČO: ");
    const entityMeasured = stringWidth("03114988");
    const pad = 12 * 0.75;

    const expectedX = 100 + prefixMeasured * rawScale - pad;
    const expectedEnd = Math.min(
      100 + pdfWidth,
      100 + (prefixMeasured + entityMeasured) * rawScale + pad,
    );

    expect(bbox.x).toBeCloseTo(expectedX, 1);
    expect(bbox.width).toBeCloseTo(expectedEnd - expectedX, 1);
  });

  it("shrinks full-TextItem bbox for table-layout PDFs", () => {
    // Full entity covering a TextItem whose PDF width is
    // 3x the measured text (table column gap inflation).
    // The box should be shrunk to effective width, not
    // span the entire inflated region.
    const text = "25565974";
    const measuredWidth = stringWidth(text);
    const pdfWidth = measuredWidth * 3; // inflated
    const s = span(0, text, 200, pdfWidth);

    const result = getEntityBBoxes([s], 0, 8, mockMeasure);

    expect(result).toHaveLength(1);
    const bbox = result[0];

    // effectiveWidth = measured * 1.5 (capped scale)
    const effectiveWidth = measuredWidth * 1.5;
    const pad = 12 * 0.75;

    // Should NOT span full pdfWidth (3x)
    expect(bbox.width).toBeLessThan(pdfWidth);
    // Should be close to effectiveWidth + pad
    expect(bbox.width).toBeCloseTo(effectiveWidth + pad, 1);
    expect(bbox.x).toBe(200);
  });

  it("handles zero-length spans gracefully", () => {
    const s: CharSpan = {
      start: 5,
      end: 5,
      text: "",
      cssFont: "12px serif",
      bbox: {
        pageIndex: 0,
        x: 50,
        y: 700,
        width: 0,
        height: 12,
        fontSize: 12,
      },
    };
    const result = getEntityBBoxes([s], 5, 10, mockMeasure);
    expect(result).toHaveLength(0);
  });

  describe("variable-width precision", () => {
    it("narrow prefix does not shift entity right", () => {
      // Prefix is all narrow chars (dots, spaces, colons)
      // This was the original bug: proportional mapping
      // estimated the entity too far right
      const text = "r.c. 850101/1234";
      const pdfWidth = stringWidth(text);
      const s = span(0, text, 50, pdfWidth);

      // Entity "850101/1234" starts at index 5
      const result = getEntityBBoxes([s], 5, 16, mockMeasure);

      expect(result).toHaveLength(1);
      const bbox = result[0];

      // The prefix "r.c. " has narrow chars (r=4, .=3,
      // c=5, .=3, space=3) = 18 px.
      // With proportional mapping (avgCharWidth * 5),
      // it would estimate 5/16 * pdfWidth which is wrong.
      // Canvas measurement gives the exact 18 px.
      const prefixWidth = stringWidth("r.c. ");
      const entityWidth = stringWidth("850101/1234");
      const pad = 12 * 0.75;

      // bbox should start near the actual prefix end
      expect(bbox.x).toBeCloseTo(50 + prefixWidth - pad, 1);
      // bbox should cover the entity
      expect(bbox.x + bbox.width).toBeGreaterThanOrEqual(
        50 + prefixWidth + entityWidth,
      );
    });
  });

  // ── Real PDF regression tests ──────────────────────────
  // Based on actual TextItem data extracted from production
  // PDFs. Each test reproduces a specific coordinate mapping
  // issue observed in the wild.

  describe("mikrorypadlo (table-layout with space separators)", () => {
    // In this PDF, table columns use space TextItems with
    // inflated widths (70-127pt) as visual separators.
    // Entity values are their own TextItems with normal
    // widths at correct x positions.

    it("iČ value in its own TextItem at correct position", () => {
      // Real data: item[28] str="25350676" w=44.16
      // x=212.45, preceded by space item[27] w=127.64
      // The entity TextItem has normal width; no inflation
      const s = span(210, "25350676", 212.45, 44.16);
      const result = getEntityBBoxes([s], 210, 218, mockMeasure);
      expect(result).toHaveLength(1);
      // Full coverage → exact bbox (no inflation to cap)
      expect(result[0].x).toBe(212.45);
      expect(result[0].width).toBeCloseTo(44.16, 1);
    });

    it("dIČ value with CZ prefix", () => {
      // Real data: item[32] str="CZ25350676" w=58.08
      // x=212.45
      const s = span(224, "CZ25350676", 212.45, 58.08);
      const result = getEntityBBoxes([s], 224, 234, mockMeasure);
      expect(result).toHaveLength(1);
      expect(result[0].x).toBe(212.45);
      expect(result[0].width).toBeCloseTo(58.08, 1);
    });

    it("person name as full TextItem", () => {
      // Real data: item[36]
      // str="Ing. Luboš Trnavský, ředitel společnosti"
      // w=177.81, x=212.45
      const text = "Ing. Luboš Trnavský, ředitel společnosti";
      const s = span(247, text, 212.45, 177.81);
      const result = getEntityBBoxes([s], 247, 287, mockMeasure);
      expect(result).toHaveLength(1);
      // Full coverage; scale = 177.81 / measured
      const measured = stringWidth(text);
      const scale = Math.min(177.81 / measured, 1.5);
      const effective = measured * scale;
      const pad = 12 * 0.75;
      expect(result[0].x).toBe(212.45);
      // Width should use effective (not raw 177.81 if
      // scale > 1.5)
      expect(result[0].width).toBeCloseTo(Math.min(177.81, effective + pad), 1);
    });

    it("entity in middle of person name span", () => {
      // NER finds just "Luboš Trnavský" within the full
      // TextItem "Ing. Luboš Trnavský, ředitel společnosti"
      const text = "Ing. Luboš Trnavský, ředitel společnosti";
      const s = span(247, text, 212.45, 177.81);

      // "Luboš Trnavský" starts at local index 5
      const entityStart = 247 + 5;
      const entityEnd = 247 + 5 + 14; // "Luboš Trnavský"
      const result = getEntityBBoxes([s], entityStart, entityEnd, mockMeasure);

      expect(result).toHaveLength(1);
      const bbox = result[0];

      // Must be positioned AFTER the "Ing. " prefix
      const rawScale = 177.81 / stringWidth(text);
      const prefixW = stringWidth("Ing. ") * rawScale;
      const pad = 12 * 0.75;
      expect(bbox.x).toBeCloseTo(212.45 + prefixW - pad, 1);
      // Must not extend beyond span
      expect(bbox.x + bbox.width).toBeLessThanOrEqual(212.45 + 177.81);
    });

    it("space-separator TextItem is skipped for entity", () => {
      // The space item (w=127.64) between label and value
      // should never produce a bbox for a value entity
      const spaceSpan = span(209, " ", 84.81, 127.64);
      const valueSpan = span(210, "25350676", 212.45, 44.16);
      const result = getEntityBBoxes(
        [spaceSpan, valueSpan],
        210,
        218,
        mockMeasure,
      );
      // Only the value span should match
      expect(result).toHaveLength(1);
      expect(result[0].x).toBe(212.45);
    });
  });

  describe("hanes (dense single-line TextItems)", () => {
    // In this PDF, multiple fields are packed into a single
    // TextItem. Entities must be extracted as sub-rects
    // within long text fragments.

    it("extracts IČO from combined IČO+DIČ TextItem", () => {
      // Real data: item[20]
      // str="25823337 CZ25823337" w=104.88 x=182.30
      // fontSize=11
      const text = "25823337 CZ25823337";
      const s: CharSpan = {
        start: 308,
        end: 327,
        text,
        cssFont: "11px serif",
        bbox: {
          pageIndex: 0,
          x: 182.3,
          y: 681.34,
          width: 104.88,
          height: 11,
          fontSize: 11,
        },
      };

      // Entity "25823337" is the first 8 chars
      const result = getEntityBBoxes([s], 308, 316, mockMeasure);

      expect(result).toHaveLength(1);
      const bbox = result[0];
      // Should start at/near the span start (clamped)
      expect(bbox.x).toBe(182.3);
      // Should NOT extend to the full 104.88 width
      expect(bbox.width).toBeLessThan(104.88);
    });

    it("extracts DIČ from combined IČO+DIČ TextItem", () => {
      // Extract "CZ25823337" from "25823337 CZ25823337"
      const text = "25823337 CZ25823337";
      const s: CharSpan = {
        start: 308,
        end: 327,
        text,
        cssFont: "11px serif",
        bbox: {
          pageIndex: 0,
          x: 182.3,
          y: 681.34,
          width: 104.88,
          height: 11,
          fontSize: 11,
        },
      };

      // "CZ25823337" starts at local index 9
      const result = getEntityBBoxes([s], 317, 327, mockMeasure);

      expect(result).toHaveLength(1);
      const bbox = result[0];
      const rawScale = 104.88 / stringWidth(text);
      const prefixW = stringWidth("25823337 ") * rawScale;
      const pad = 11 * 0.75;
      // Should be positioned after the "25823337 " prefix
      expect(bbox.x).toBeCloseTo(182.3 + prefixW - pad, 1);
    });

    it("long dense line — entity deep in text", () => {
      // Real data: item[33] — single TextItem with all of
      // company 2's info packed in one line
      // str="Se sídlem: U Albrechtova vrchu 7, 155 00
      //  Praha 5 Zastoupena: Filip Hachle IČO:
      //  261 319 19 DIČ:" w=437.20 x=66.98
      const text =
        "Se sídlem: U Albrechtova vrchu 7, " +
        "155 00 Praha 5 Zastoupena: " +
        "Filip Hachle IČO: 261 319 19 DIČ:";
      const measured = stringWidth(text);
      const pdfWidth = 437.2;
      const s: CharSpan = {
        start: 400,
        end: 400 + text.length,
        text,
        cssFont: "11px serif",
        bbox: {
          pageIndex: 0,
          x: 66.98,
          y: 559.51,
          width: pdfWidth,
          height: 11,
          fontSize: 11,
        },
      };

      // Entity "Filip Hachle" — find its position
      const entityText = "Filip Hachle";
      const localStart = text.indexOf(entityText);
      const localEnd = localStart + entityText.length;
      const result = getEntityBBoxes(
        [s],
        400 + localStart,
        400 + localEnd,
        mockMeasure,
      );

      expect(result).toHaveLength(1);
      const bbox = result[0];
      const rawScale = pdfWidth / measured;
      const entityW = stringWidth(entityText) * rawScale;
      const pad = 11 * 0.75;

      // Box must be near the entity position, not at x=67
      expect(bbox.x).toBeGreaterThan(66.98 + 100);
      // Box must not extend past the span
      expect(bbox.x + bbox.width).toBeLessThanOrEqual(66.98 + pdfWidth);
      // Box should reasonably cover the entity text
      expect(bbox.width).toBeGreaterThan(entityW * 0.5);
      expect(bbox.width).toBeLessThanOrEqual(entityW + 2 * pad + 0.01);
    });

    it("entity at the very end of a dense line", () => {
      // "261 319 19" at the end of the dense TextItem,
      // right before "DIČ:"
      const text =
        "Se sídlem: U Albrechtova vrchu 7, " +
        "155 00 Praha 5 Zastoupena: " +
        "Filip Hachle IČO: 261 319 19 DIČ:";
      const pdfWidth = 437.2;
      const s: CharSpan = {
        start: 400,
        end: 400 + text.length,
        text,
        cssFont: "11px serif",
        bbox: {
          pageIndex: 0,
          x: 66.98,
          y: 559.51,
          width: pdfWidth,
          height: 11,
          fontSize: 11,
        },
      };

      const entityText = "261 319 19";
      const localStart = text.indexOf(entityText);
      const localEnd = localStart + entityText.length;
      const result = getEntityBBoxes(
        [s],
        400 + localStart,
        400 + localEnd,
        mockMeasure,
      );

      expect(result).toHaveLength(1);
      const bbox = result[0];
      // Should be positioned far right in the line
      expect(bbox.x).toBeGreaterThan(66.98 + 200);
      // Must not extend past span boundary
      expect(bbox.x + bbox.width).toBeLessThanOrEqual(66.98 + pdfWidth);
    });

    it("company name at the start of span", () => {
      // Real data: item[0]
      // str="1. TS Bruntál s.r.o." w=97.75 x=67.22
      // Entity: "TS Bruntál s.r.o." (skip "1. " prefix)
      const text = "1. TS Bruntál s.r.o.";
      const s: CharSpan = {
        start: 0,
        end: 20,
        text,
        cssFont: "12px serif",
        bbox: {
          pageIndex: 0,
          x: 67.22,
          y: 738.1,
          width: 97.75,
          height: 12,
          fontSize: 12,
        },
      };

      // Entity "TS Bruntál s.r.o." starts after "1. "
      const result = getEntityBBoxes([s], 3, 20, mockMeasure);

      expect(result).toHaveLength(1);
      const bbox = result[0];
      // Should be offset from span start by prefix
      expect(bbox.x).toBeGreaterThan(67.22);
      // But not too far (prefix "1. " is short)
      expect(bbox.x).toBeLessThan(67.22 + 30);
    });

    it("address across multiple TextItems", () => {
      // In the Hanes PDF, the address could span from
      // item[18] into item[19] if the entity covers both.
      // item[18]: "Zeyerova 1489/12, 792 01 Bruntál..."
      //   w=336.46 x=182.30
      // item[20]: "25823337 CZ25823337" w=104.88 x=182.30
      // Simulate two adjacent spans where entity spans both
      const s1: CharSpan = {
        start: 280,
        end: 350,
        text:
          "Zeyerova 1489/12, 792 01 Bruntál " +
          "společnost s ručením omezením, kód 112",
        cssFont: "11px serif",
        bbox: {
          pageIndex: 0,
          x: 182.3,
          y: 697.3,
          width: 336.46,
          height: 11,
          fontSize: 11,
        },
      };
      const s2: CharSpan = {
        start: 351,
        end: 370,
        text: "25823337 CZ25823337",
        cssFont: "11px serif",
        bbox: {
          pageIndex: 0,
          x: 182.3,
          y: 681.34,
          width: 104.88,
          height: 11,
          fontSize: 11,
        },
      };

      // Entity spans the end of s1 and start of s2:
      // "kód 112" + "25823337"
      const result = getEntityBBoxes([s1, s2], 343, 359, mockMeasure);

      // Should produce two bboxes (one per span)
      expect(result).toHaveLength(2);
      // First bbox in span 1, second in span 2
      expect(result[0].pageIndex).toBe(0);
      expect(result[1].pageIndex).toBe(0);
    });
  });

  describe("edge cases for robustness", () => {
    it("single-character entity", () => {
      const s = span(0, "A B C", 50, 30);
      // Entity is just "B" at index 2
      const result = getEntityBBoxes([s], 2, 3, mockMeasure);
      expect(result).toHaveLength(1);
      // Should produce a reasonable bbox (not zero-width)
      expect(result[0].width).toBeGreaterThan(0);
    });

    it("entity at exact end of span", () => {
      const text = "hodnota: 12345";
      const s = span(0, text, 100, stringWidth(text));
      // Entity "12345" is the last 5 chars
      const result = getEntityBBoxes([s], 9, 14, mockMeasure);
      expect(result).toHaveLength(1);
      // Right edge should be clamped to span end
      expect(result[0].x + result[0].width).toBeLessThanOrEqual(
        100 + stringWidth(text),
      );
    });

    it("very small fontSize does not produce negative pad", () => {
      // Some PDFs have tiny font sizes (e.g., footnotes)
      const s: CharSpan = {
        start: 0,
        end: 5,
        text: "hello",
        cssFont: "4px serif",
        bbox: {
          pageIndex: 0,
          x: 50,
          y: 700,
          width: 20,
          height: 4,
          fontSize: 4,
        },
      };
      const result = getEntityBBoxes([s], 0, 5, mockMeasure);
      expect(result).toHaveLength(1);
      expect(result[0].width).toBeGreaterThan(0);
      expect(result[0].x).toBeGreaterThanOrEqual(50);
    });

    it("span with very large PDF width (scanned PDF OCR)", () => {
      // OCR engines sometimes produce TextItems with
      // wildly inaccurate widths (10x or more)
      const text = "12345678";
      const measured = stringWidth(text);
      const s = span(0, text, 100, measured * 10);
      const result = getEntityBBoxes([s], 0, 8, mockMeasure);
      expect(result).toHaveLength(1);
      // Should cap to effective width, not use 10x
      const effectiveWidth = measured * 1.5;
      const pad = 12 * 0.75;
      expect(result[0].width).toBeLessThan(measured * 5);
      expect(result[0].width).toBeCloseTo(effectiveWidth + pad, 1);
    });

    it("multiple entities in same span do not interfere", () => {
      // Two entities in the same TextItem: IČO and DIČ
      const text = "25823337 CZ25823337";
      const measured = stringWidth(text);
      const s = span(0, text, 182.3, measured);

      const r1 = getEntityBBoxes([s], 0, 8, mockMeasure);
      const r2 = getEntityBBoxes([s], 9, 19, mockMeasure);

      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      // IČO box should be to the left of DIČ box
      expect(r1[0].x).toBeLessThan(r2[0].x);
      // They should not overlap (allowing for padding)
      const r1End = r1[0].x + r1[0].width;
      const r2Start = r2[0].x;
      // With padding they might overlap slightly, but
      // the raw positions should be ordered
      expect(r1End).toBeLessThan(r2Start + 2 * 12 * 0.75);
    });
  });

  describe("solaris (multi-TextItem entity on same line)", () => {
    // In this PDF, the organization name is split across
    // 4 TextItems on the same line due to font changes
    // (bold/italic/regular). Without merging, each TextItem
    // gets its own bbox, creating overlapping coloured boxes.

    /** Build a CharSpan with fontSize=9 (matches the PDF). */
    const span9 = (
      start: number,
      text: string,
      x: number,
      pdfWidth: number,
    ): CharSpan => ({
      start,
      end: start + text.length,
      text,
      cssFont: "9px serif",
      bbox: {
        pageIndex: 1,
        x,
        y: 718.78,
        width: pdfWidth,
        height: 9,
        fontSize: 9,
      },
    });

    it("merges contiguous bboxes on the same line", () => {
      // Real data from Solaris PDF page 2: entity
      // "Dodávka autobusů pro Dopravní podnik měst"
      // split across 4 TextItems (different fonts)
      const spans: CharSpan[] = [
        span9(563, "Dodávk", 355.27, 28.2),
        span9(570, "a", 383.47, 4.45),
        span9(572, " ", 387.92, 4.79),
        span9(574, "autobusů pro Dopravní podnik měst", 392.71, 145.92),
      ];

      // Entity covers all 4 spans (563 to 607)
      const result = getEntityBBoxes(spans, 563, 607, mockMeasure);

      // Should merge into ONE bbox, not 4 separate ones
      expect(result).toHaveLength(1);
      // Should start at the first span's x
      expect(result[0].x).toBe(355.27);
      // Should extend to cover the last span
      const lastEnd = 392.71 + 145.92;
      expect(result[0].x + result[0].width).toBeCloseTo(lastEnd, 0);
    });

    it("does not merge bboxes on different lines", () => {
      // Entity continues on the next line. All 4 line-1
      // spans are contiguous and should merge; line 2 is
      // a separate line and should NOT merge with line 1.
      const line1: CharSpan[] = [
        span9(563, "Dodávk", 355.27, 28.2),
        span9(570, "a", 383.47, 4.45),
        span9(572, " ", 387.92, 4.79),
        span9(574, "autobusů pro Dopravní podnik měst", 392.71, 145.92),
      ];
      const line2: CharSpan = {
        start: 608,
        end: 633,
        text: "Chomutova a Jirkova a. s.",
        cssFont: "9px serif",
        bbox: {
          pageIndex: 1,
          x: 85.1,
          y: 707.86,
          width: 97.5,
          height: 9,
          fontSize: 9,
        },
      };

      const result = getEntityBBoxes([...line1, line2], 563, 633, mockMeasure);

      // Line 1 spans merge into 1; line 2 stays separate
      expect(result).toHaveLength(2);
      // First merged bbox on line 1
      expect(result[0].y).toBe(718.78);
      // Second bbox on line 2
      expect(result[1].y).toBe(707.86);
      expect(result[1].x).toBe(85.1);
    });

    it("merges bboxes with small gaps (font kerning)", () => {
      // TextItems may have tiny gaps (< 2pt) between them
      // due to kerning or rounding; these should merge
      const spans: CharSpan[] = [
        span9(0, "Dopravní", 100, 40),
        // 1.5pt gap (100+40=140, next starts at 141.5)
        span9(9, "podnik", 141.5, 30),
      ];
      const result = getEntityBBoxes(spans, 0, 15, mockMeasure);
      expect(result).toHaveLength(1);
      expect(result[0].x).toBe(100);
    });

    it("does not merge bboxes with large gaps", () => {
      // Two TextItems far apart on the same line should
      // NOT be merged (they're in different columns)
      const spans: CharSpan[] = [
        span9(0, "IČO:", 70, 20),
        span9(5, "25823337", 250, 40),
      ];
      const result = getEntityBBoxes(spans, 0, 13, mockMeasure);
      // Should remain 2 separate bboxes (180pt gap)
      expect(result).toHaveLength(2);
    });
  });
});
