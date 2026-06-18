import { describe, expect, test } from "bun:test";

import { paragraphToStyle } from "./formatToStyle";
import { AUTO_PARAGRAPH_SPACING_PX } from "./units";

// eigenpal/docx-editor#823 — HTML-origin paragraphs carry
// `w:beforeAutospacing`/`w:afterAutospacing`. Word ignores any explicit
// before/after on such paragraphs and renders ~14px. The editor previously
// honored only the explicit values, so imports rendered too tight.
describe("paragraphToStyle auto spacing", () => {
  test("auto spacing overrides explicit before/after", () => {
    const style = paragraphToStyle({
      beforeAutospacing: true,
      afterAutospacing: true,
      spaceBefore: 100, // ~6.7px; auto must win
      spaceAfter: 100,
    });

    expect(style.marginTop).toBe(`${AUTO_PARAGRAPH_SPACING_PX}px`);
    expect(style.marginBottom).toBe(`${AUTO_PARAGRAPH_SPACING_PX}px`);
  });

  test("explicit spacing is still used when no auto flag is set", () => {
    const style = paragraphToStyle({ spaceBefore: 240 }); // 240 twips = 16px
    expect(style.marginTop).toBe("16px");
  });
});
