import { describe, expect, test } from "bun:test";

import type { StyleSetEditorSettings } from "@/features/style-sets/style-set-editor-types";
import {
  previewLineHeight,
  previewNumberingMarkers,
  previewPaperRatio,
} from "@/features/style-sets/style-set-preview.logic";

const settings = {
  numbering: { enabled: true },
  level1: { numberingFormat: "decimal" },
  level2: { numberingFormat: "hierarchicalDecimal" },
  level3: { numberingFormat: "lowerLetterParenthetical" },
} satisfies Pick<StyleSetEditorSettings, "numbering"> & {
  level1: Pick<StyleSetEditorSettings["level1"], "numberingFormat">;
  level2: Pick<StyleSetEditorSettings["level2"], "numberingFormat">;
  level3: Pick<StyleSetEditorSettings["level3"], "numberingFormat">;
};

describe("style set preview projection", () => {
  test("uses the selected legal numbering conventions", () => {
    expect(previewNumberingMarkers(settings)).toEqual({
      level1: "1",
      level2: "1.1",
      level3: "(a)",
    });
  });

  test("mirrors line spacing and paper orientation", () => {
    expect(previewLineHeight("onePoint5")).toBe(1.5);
    expect(
      previewPaperRatio({
        paperSize: "a4",
        orientation: "portrait",
        marginTopPt: 72,
        marginBottomPt: 72,
        marginLeftPt: 72,
        marginRightPt: 72,
      }),
    ).toBeGreaterThan(1);
    expect(
      previewPaperRatio({
        paperSize: "a4",
        orientation: "landscape",
        marginTopPt: 72,
        marginBottomPt: 72,
        marginLeftPt: 72,
        marginRightPt: 72,
      }),
    ).toBeLessThan(1);
  });
});
