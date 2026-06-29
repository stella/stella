import { describe, expect, test } from "bun:test";

import {
  normalizeTableColumnWidths,
  resolveTableWidthPx,
} from "./tableWidthUtils";

describe("resolveTableWidthPx", () => {
  test("dxa twips are converted to pixels", () => {
    expect(resolveTableWidthPx(1440, "dxa", 600)).toBeCloseTo(96, 1);
  });

  test("pct is interpreted as 50ths of a percent", () => {
    expect(resolveTableWidthPx(2500, "pct", 600)).toBe(300);
    expect(resolveTableWidthPx(5000, "pct", 600)).toBe(600);
    expect(resolveTableWidthPx(1, "pct", 5000)).toBeCloseTo(1, 5);
  });
});

describe("normalizeTableColumnWidths", () => {
  test("zero and negative widths split leftover target evenly", () => {
    const out = normalizeTableColumnWidths([100, 0, 100, -5], 4, 400);
    expect(out[0]).toBe(100);
    expect(out[2]).toBe(100);
    expect(out[1]).toBeCloseTo(100, 5);
    expect(out[3]).toBeCloseTo(100, 5);
  });
});
