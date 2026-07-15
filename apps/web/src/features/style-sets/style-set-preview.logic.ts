import type { StyleSetEditorSettings } from "@/features/style-sets/style-set-editor-types";

type PreviewNumberingSettings = {
  numbering: Pick<StyleSetEditorSettings["numbering"], "enabled">;
  level1: Pick<StyleSetEditorSettings["level1"], "numberingFormat">;
  level2: Pick<StyleSetEditorSettings["level2"], "numberingFormat">;
  level3: Pick<StyleSetEditorSettings["level3"], "numberingFormat">;
};

export const previewNumberingMarkers = (
  settings: PreviewNumberingSettings,
): { level1: string; level2: string; level3: string } => {
  if (!settings.numbering.enabled) {
    return { level1: "", level2: "", level3: "" };
  }
  return {
    level1: marker(settings.level1.numberingFormat, 1),
    level2: marker(settings.level2.numberingFormat, 2),
    level3: marker(settings.level3.numberingFormat, 3),
  };
};

const marker = (
  format: StyleSetEditorSettings["level1"]["numberingFormat"],
  level: 1 | 2 | 3,
): string => {
  if (format === "hierarchicalDecimal") {
    if (level === 1) {
      return "1";
    }
    if (level === 2) {
      return "1.1";
    }
    return "1.1.1";
  }
  if (format === "lowerLetterParenthetical") {
    return "(a)";
  }
  if (format === "lowerRomanParenthetical") {
    return "(i)";
  }
  if (format === "upperLetterParenthetical") {
    return "(A)";
  }
  if (format === "upperRoman") {
    return "I";
  }
  if (format === "decimal") {
    return "1";
  }
  if (level === 1) {
    return "1";
  }
  if (level === 2) {
    return "1.1";
  }
  return "(a)";
};

export const previewLineHeight = (
  lineSpacing: StyleSetEditorSettings["body"]["lineSpacing"],
): number => {
  if (lineSpacing === "single") {
    return 1;
  }
  if (lineSpacing === "onePoint15") {
    return 1.15;
  }
  if (lineSpacing === "onePoint5") {
    return 1.5;
  }
  if (lineSpacing === "double") {
    return 2;
  }
  return 1.2;
};

export const previewPaperRatio = (
  page: StyleSetEditorSettings["page"],
): number => {
  let portraitRatio = 297 / 210;
  if (page.paperSize === "letter") {
    portraitRatio = 11 / 8.5;
  }
  if (page.paperSize === "legal") {
    portraitRatio = 14 / 8.5;
  }
  return page.orientation === "portrait" ? portraitRatio : 1 / portraitRatio;
};
