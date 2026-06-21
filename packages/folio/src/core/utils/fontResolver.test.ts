import { describe, expect, test } from "bun:test";

import { getGoogleFontEquivalent, resolveFontFamily } from "./fontResolver";

describe("fontResolver — native CJK theme typefaces map to matched Noto fonts", () => {
  // The names `applyThemeFontLang` writes into the empty `<a:ea>` slot are the
  // native typeface names from `theme1.xml`, not the romanized ones. Each must
  // resolve to the matching Noto family so measurement and rendering agree, as
  // Japanese already does. (folio bundles no CJK webfonts; the Noto family is a
  // CSS fallback token that resolves to the viewer's OS face when present.)
  const nativeCases: [string, string][] = [
    // Simplified Chinese
    ["宋体", "Noto Serif SC"],
    ["黑体", "Noto Sans SC"],
    ["微软雅黑", "Noto Sans SC"],
    ["等线", "Noto Sans SC"],
    ["仿宋", "Noto Serif SC"],
    ["楷体", "Noto Serif SC"],
    // Traditional Chinese
    ["新細明體", "Noto Serif TC"],
    ["細明體", "Noto Serif TC"],
    ["微軟正黑體", "Noto Sans TC"],
    ["標楷體", "Noto Serif TC"],
    // Korean
    ["맑은 고딕", "Noto Sans KR"],
    ["굴림", "Noto Sans KR"],
    ["돋움", "Noto Sans KR"],
    ["바탕", "Noto Serif KR"],
    ["궁서", "Noto Serif KR"],
    // Japanese native (full-width) — Phase 2 theme path writes these.
    ["ＭＳ 明朝", "Noto Serif JP"],
    ["ＭＳ ゴシック", "Noto Sans JP"],
  ];

  for (const [name, font] of nativeCases) {
    test(`${name} → ${font}`, () => {
      const resolved = resolveFontFamily(name);
      expect(resolved.googleFont).toBe(font);
      expect(resolved.hasGoogleEquivalent).toBe(true);
      expect(getGoogleFontEquivalent(name)).toBe(font);
    });
  }
});

describe("fontResolver — romanized CJK aliases resolve to the native entry", () => {
  // Word writes the romanized name in run `rFonts`; it must land on the same
  // Noto family + serif/sans category as the native theme name.
  const aliasCases: [string, string, "serif" | "sans-serif"][] = [
    ["SimSun", "Noto Serif SC", "serif"],
    ["Microsoft YaHei", "Noto Sans SC", "sans-serif"],
    ["DengXian", "Noto Sans SC", "sans-serif"],
    ["PMingLiU", "Noto Serif TC", "serif"],
    ["Microsoft JhengHei", "Noto Sans TC", "sans-serif"],
    ["Batang", "Noto Serif KR", "serif"],
    ["Malgun Gothic", "Noto Sans KR", "sans-serif"],
    ["MS Mincho", "Noto Serif JP", "serif"],
    ["Meiryo", "Noto Sans JP", "sans-serif"],
    ["Yu Mincho", "Noto Serif JP", "serif"],
  ];

  for (const [name, font, category] of aliasCases) {
    test(`${name} → ${font} (${category})`, () => {
      const resolved = resolveFontFamily(name);
      expect(resolved.googleFont).toBe(font);
      expect(resolved.hasGoogleEquivalent).toBe(true);
      // A serif Noto family means the run will render with a serif fallback,
      // which is what the serif/sans split must preserve.
      const isSerif = /Noto Serif/u.test(resolved.googleFont ?? "");
      expect(isSerif).toBe(category === "serif");
    });
  }
});

describe("fontResolver — unmapped native serif faces stay serif", () => {
  // `detectFontCategory` must keep a 明朝/明體/宋 face serif even with no direct
  // mapping, so the generic fallback tail is `serif`, not `sans-serif`.
  for (const name of ["源ノ明朝", "未知明體", "某宋体变体"]) {
    test(`${name} falls back to a serif stack`, () => {
      const resolved = resolveFontFamily(name);
      expect(resolved.cssFallback.endsWith("serif")).toBe(true);
      expect(resolved.cssFallback.includes("sans-serif")).toBe(false);
    });
  }
});
