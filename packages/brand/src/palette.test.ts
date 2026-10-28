import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BRAND_COLORS,
  BRAND_PALETTE,
  BRAND_SRGB,
  NEUTRAL_COLORS,
  NEUTRAL_SRGB,
  srgbFromHex,
} from "./palette";

const DESIGN_DOC = path.resolve(import.meta.dir, "../../../DESIGN.md");

// The rows between DESIGN.md's generated brand colour markers.
const documentedBrandRows = (): string[][] => {
  const doc = readFileSync(DESIGN_DOC, "utf-8");
  const begin = doc.indexOf("<!-- BEGIN GENERATED BRAND COLOURS -->");
  const end = doc.indexOf("<!-- END GENERATED BRAND COLOURS -->");
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return doc
    .slice(begin, end)
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
};

describe("brand palette", () => {
  test("DESIGN.md documents exactly the palette, in order", () => {
    expect(documentedBrandRows()).toEqual(
      Object.values(BRAND_PALETTE).map(({ label, hex, usage }) => [
        label,
        `\`${hex}\``,
        usage,
      ]),
    );
  });

  test("the hex map is the palette's hex values", () => {
    expect(BRAND_COLORS).toEqual({
      black: BRAND_PALETTE.black.hex,
      softBlue: BRAND_PALETTE.softBlue.hex,
      paleBlue: BRAND_PALETTE.paleBlue.hex,
      blueAccent: BRAND_PALETTE.blueAccent.hex,
    });
  });

  test("sRGB triples are the hex channels over 255", () => {
    expect(BRAND_SRGB.blueAccent).toEqual([0x59 / 255, 0xa1 / 255, 0xd4 / 255]);
    expect(BRAND_SRGB.black).toEqual([0, 0, 0]);
    expect(NEUTRAL_SRGB.white).toEqual([1, 1, 1]);
    expect(NEUTRAL_COLORS.black).toBe(BRAND_COLORS.black);
  });

  test("a three-digit hex expands each digit", () => {
    expect(srgbFromHex("#abc")).toEqual(srgbFromHex("#aabbcc"));
  });

  test("every channel stays in 0..1 for any six-digit hex", () => {
    for (let value = 0; value <= 0xff_ff_ff; value += 0x01_23_45) {
      const triple = srgbFromHex(`#${value.toString(16).padStart(6, "0")}`);
      for (const channel of triple) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  test("a malformed hex is rejected", () => {
    expect(() => srgbFromHex("#12")).toThrow("Not a #rgb or #rrggbb colour");
    expect(() => srgbFromHex("#ggg")).toThrow("Not a #rgb or #rrggbb colour");
  });
});
