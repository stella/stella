/**
 * Shared helper for projecting a resolved paragraph style onto ProseMirror
 * paragraph node attrs.
 *
 * Both `applyStyle` (toolbar style picker) and the Enter handler's
 * next-style switch need to write the same set of style-controlled attrs.
 * Keeping the projection in one place ensures the two paths stay in sync —
 * a style applied via the picker and a style applied on Enter produce
 * identical paragraph attrs.
 */

import type { ResolvedParagraphStyle } from "./styleResolver";

/**
 * The paragraph attrs a style definition controls. Applying a style resets
 * every one of these to the style's value (or `null` to clear), so a prior
 * style's properties (e.g. a heading's spacing) never leak through. Returns
 * a partial attrs object to merge over the paragraph's existing attrs.
 */
export function paragraphAttrsFromResolvedStyle(
  resolved: ResolvedParagraphStyle,
): Record<string, unknown> {
  const ppr = resolved.paragraphFormatting;
  const runFormatting = resolved.runFormatting;
  const hasRunFormatting =
    !!runFormatting && Object.keys(runFormatting).length > 0;

  return {
    alignment: ppr?.alignment ?? null,
    spaceBefore: ppr?.spaceBefore ?? null,
    spaceAfter: ppr?.spaceAfter ?? null,
    lineSpacing: ppr?.lineSpacing ?? null,
    lineSpacingRule: ppr?.lineSpacingRule ?? null,
    indentLeft: ppr?.indentLeft ?? null,
    indentRight: ppr?.indentRight ?? null,
    indentFirstLine: ppr?.indentFirstLine ?? null,
    hangingIndent: ppr?.hangingIndent ?? null,
    contextualSpacing: ppr?.contextualSpacing ?? null,
    keepNext: ppr?.keepNext ?? null,
    keepLines: ppr?.keepLines ?? null,
    pageBreakBefore: ppr?.pageBreakBefore ?? null,
    outlineLevel: ppr?.outlineLevel ?? null,
    // The style's run defaults drive the caret height in an empty paragraph
    // and the formatting typed text inherits (see EmptyParagraphFormatExtension).
    defaultTextFormatting: hasRunFormatting ? runFormatting : null,
  };
}
