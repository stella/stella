import { describe, expect, test } from "bun:test";

import type { Theme, ThemeFontScheme } from "../types/document";
import { applyThemeFontLang, resolveThemeFontRef } from "./themeParser";

/**
 * Builds a theme that mirrors Office's default font scheme: the `<a:ea>` /
 * `<a:cs>` slots are empty and the real CJK/complex-script typefaces live in
 * script-specific `<a:font>` entries.
 */
function officeLikeTheme(): Theme & { fontScheme: ThemeFontScheme } {
  return {
    name: "Office",
    colorScheme: {
      dk1: "000000",
      lt1: "FFFFFF",
      dk2: "44546A",
      lt2: "E7E6E6",
      accent1: "4472C4",
      accent2: "ED7D31",
      accent3: "A5A5A5",
      accent4: "FFC000",
      accent5: "5B9BD5",
      accent6: "70AD47",
      hlink: "0563C1",
      folHlink: "954F72",
    },
    fontScheme: {
      majorFont: {
        latin: "Arial",
        ea: "",
        cs: "",
        fonts: {
          Jpan: "ＭＳ ゴシック",
          Hang: "맑은 고딕",
          Hans: "宋体",
          Arab: "Times New Roman",
        },
      },
      minorFont: {
        latin: "Century",
        ea: "",
        cs: "",
        fonts: {
          Jpan: "ＭＳ 明朝",
          Hang: "맑은 고딕",
          Hans: "宋体",
          Arab: "Arial",
        },
      },
    },
  };
}

describe("applyThemeFontLang", () => {
  test("fills empty EastAsian slots from the Japanese script font", () => {
    const theme = officeLikeTheme();
    applyThemeFontLang(theme, { eastAsia: "ja-JP" });

    expect(theme.fontScheme.minorFont?.ea).toBe("ＭＳ 明朝");
    expect(theme.fontScheme.majorFont?.ea).toBe("ＭＳ ゴシック");
    // A run referencing minorEastAsia now resolves to a concrete typeface.
    expect(resolveThemeFontRef(theme, "minorEastAsia")).toBe("ＭＳ 明朝");
  });

  test("selects the Hant typeface for Traditional Chinese locales", () => {
    const theme = officeLikeTheme();
    theme.fontScheme.minorFont!.fonts = { Hans: "宋体", Hant: "新細明體" };
    applyThemeFontLang(theme, { eastAsia: "zh-TW" });
    expect(theme.fontScheme.minorFont?.ea).toBe("新細明體");
  });

  test("fills empty complex-script slots from the bidi language", () => {
    const theme = officeLikeTheme();
    applyThemeFontLang(theme, { bidi: "ar-SA" });
    // Untouched without an eastAsia lang.
    expect(theme.fontScheme.minorFont?.ea).toBe("");
    expect(theme.fontScheme.minorFont?.cs).toBe("Arial");
    expect(theme.fontScheme.majorFont?.cs).toBe("Times New Roman");
  });

  test("does not overwrite a non-empty ea typeface", () => {
    const theme = officeLikeTheme();
    theme.fontScheme.minorFont!.ea = "Yu Mincho";
    applyThemeFontLang(theme, { eastAsia: "ja-JP" });
    expect(theme.fontScheme.minorFont?.ea).toBe("Yu Mincho");
  });

  test("is a no-op without themeFontLang", () => {
    const theme = officeLikeTheme();
    applyThemeFontLang(theme, undefined);
    expect(theme.fontScheme.minorFont?.ea).toBe("");
  });

  test("leaves slots empty when no script font matches the language", () => {
    const theme = officeLikeTheme();
    theme.fontScheme.minorFont!.fonts = { Hang: "맑은 고딕" };
    applyThemeFontLang(theme, { eastAsia: "ja-JP" });
    expect(theme.fontScheme.minorFont?.ea).toBe("");
  });
});
