// `w:val="clear"` shading is "no pattern" — the `w:fill` colour is shown as a
// solid background, NOT transparent. resolveShadingFill previously returned
// transparent for any `clear` pattern before inspecting the fill, dropping
// legitimate `<w:shd w:val="clear" w:fill="…"/>` backgrounds. Only `nil` means
// no shading. (Regression for the eigenpal #722 / #712 shading work.)

import { describe, expect, test } from "bun:test";

import type { ShadingProperties } from "../../types/colors";
import { resolveShadingFill } from "../formatToStyle";

describe("resolveShadingFill — clear pattern shows the fill", () => {
  test("clear + concrete fill renders the fill as a solid background", () => {
    expect(
      resolveShadingFill({ pattern: "clear", fill: { rgb: "D9D9D9" } }),
    ).toBe("#D9D9D9");
  });

  test("clear with no explicit pattern attribute also renders the fill", () => {
    expect(resolveShadingFill({ fill: { rgb: "00B050" } })).toBe("#00B050");
  });

  test("nil means no shading — the fill is ignored", () => {
    expect(
      resolveShadingFill({ pattern: "nil", fill: { rgb: "D9D9D9" } }),
    ).toBe("");
  });

  test("clear + white/auto fills stay transparent (page-background no-ops)", () => {
    expect(
      resolveShadingFill({ pattern: "clear", fill: { rgb: "FFFFFF" } }),
    ).toBe("");
    expect(resolveShadingFill({ pattern: "clear", fill: { auto: true } })).toBe(
      "",
    );
  });

  test("clear with no fill is transparent", () => {
    const shading: ShadingProperties = { pattern: "clear" };
    expect(resolveShadingFill(shading)).toBe("");
  });

  test("solid pattern still uses the pattern colour when there is no fill", () => {
    expect(
      resolveShadingFill({ pattern: "solid", color: { rgb: "FF0000" } }),
    ).toBe("#FF0000");
  });

  test("undefined shading is transparent", () => {
    expect(resolveShadingFill(undefined)).toBe("");
  });
});
