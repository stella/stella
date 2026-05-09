import { describe, expect, test } from "bun:test";

import { emuToPixels, emuToTwips, pixelsToEmu, twipsToEmu } from "./units";

// Microsoft Word treats EMU/twip attributes as integer-typed (xs:long /
// xs:unsignedInt). IEEE-754 drift such as `(52 / 96) * 914400 ===
// 495299.99999999994` makes Word reject the file as corrupt while WPS,
// LibreOffice, and Google Docs tolerate it. Upstream eigenpal/docx-editor
// fixed this in #422 — port the same defense.
describe("EMU/twip conversions return integers", () => {
  test("pixelsToEmu rounds the IEEE-754 drift cases from issue #417", () => {
    // 52 px → 495299.99999999994 unrounded
    expect(pixelsToEmu(52)).toBe(495_300);
    // 98 px → 933449.9999999999 unrounded
    expect(pixelsToEmu(98)).toBe(933_450);
    // 25 px → 238125.00000000003 unrounded
    expect(pixelsToEmu(25)).toBe(238_125);
    // 200 px → 1905000.0000000002 unrounded
    expect(pixelsToEmu(200)).toBe(1_905_000);
  });

  test("pixelsToEmu always returns an integer", () => {
    for (let px = 1; px <= 800; px += 1) {
      expect(Number.isInteger(pixelsToEmu(px))).toBe(true);
    }
    expect(Number.isInteger(pixelsToEmu(123.456))).toBe(true);
  });

  test("twipsToEmu and emuToTwips round to integers", () => {
    expect(Number.isInteger(twipsToEmu(720))).toBe(true);
    expect(Number.isInteger(emuToTwips(914_400))).toBe(true);
    expect(twipsToEmu(1440)).toBe(914_400);
    expect(emuToTwips(914_400)).toBe(1440);
  });

  test("emuToPixels still rounds and tolerates null/NaN", () => {
    expect(emuToPixels(914_400)).toBe(96);
    expect(emuToPixels(null)).toBe(0);
    expect(emuToPixels(undefined)).toBe(0);
    expect(emuToPixels(Number.NaN)).toBe(0);
  });
});
