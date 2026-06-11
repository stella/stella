import type { ParagraphFormatting } from "../types/document";
import { mergeTextFormatting } from "./textFormattingMerge";

const PARAGRAPH_REPLACE_KEYS = [
  "alignment",
  "bidi",
  "spaceBefore",
  "spaceAfter",
  "lineSpacing",
  "lineSpacingRule",
  "beforeAutospacing",
  "afterAutospacing",
  "spacingExplicit",
  "indentLeft",
  "indentRight",
  "indentFirstLine",
  "hangingIndent",
  "shading",
  "keepNext",
  "keepLines",
  "widowControl",
  "pageBreakBefore",
  "contextualSpacing",
  "outlineLevel",
  "styleId",
  "suppressLineNumbers",
  "suppressAutoHyphens",
  "runInWithNext",
] as const satisfies readonly (keyof ParagraphFormatting)[];

type ParagraphReplaceKey = (typeof PARAGRAPH_REPLACE_KEYS)[number];

const copyDefinedParagraphProperty = <K extends ParagraphReplaceKey>(
  target: Pick<ParagraphFormatting, K>,
  source: Pick<ParagraphFormatting, K>,
  key: K,
): void => {
  const value = source[key];
  if (value !== undefined) {
    target[key] = value;
  }
};

/**
 * Merge paragraph properties for OOXML style cascade resolution.
 *
 * The source is the higher-priority layer. Most `w:pPr` properties replace an
 * inherited value when present; nested child containers merge by child field;
 * tabs replace as a complete ordered collection; paragraph mark `w:rPr` uses
 * the run-formatting merge rules.
 */
export function mergeParagraphFormatting(
  target: ParagraphFormatting | undefined,
  source: ParagraphFormatting | undefined,
): ParagraphFormatting | undefined {
  if (!source) {
    return target;
  }
  if (!target) {
    const result = { ...source };
    if (source.tabs !== undefined) {
      result.tabs = [...source.tabs];
    }
    return result;
  }

  const result: ParagraphFormatting = { ...target };

  for (const key of PARAGRAPH_REPLACE_KEYS) {
    copyDefinedParagraphProperty(result, source, key);
  }

  const mergedRunProperties = mergeTextFormatting(
    result.runProperties,
    source.runProperties,
  );
  if (mergedRunProperties) {
    result.runProperties = mergedRunProperties;
  }

  if (source.borders !== undefined) {
    result.borders = { ...result.borders, ...source.borders };
  }
  if (source.numPr !== undefined) {
    result.numPr = { ...result.numPr, ...source.numPr };
  }
  if (source.frame !== undefined) {
    result.frame = { ...result.frame, ...source.frame };
  }
  if (source.tabs !== undefined) {
    result.tabs = [...source.tabs];
  }

  return result;
}
