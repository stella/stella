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

import {
  computeListRendering,
  type NumberingMap,
} from "../../docx/numberingParser";
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
    // Custom paragraph styles (callouts, bordered headings) carry their own
    // `w:pBdr`; the picker and the Enter-into-w:next path both need to apply
    // them, while clearing any source paragraph's leftover borders when the
    // new style has none.
    borders: ppr?.borders ?? null,
    // The style's run defaults drive the caret height in an empty paragraph
    // and the formatting typed text inherits (see EmptyParagraphFormatExtension).
    defaultTextFormatting: hasRunFormatting ? runFormatting : null,
  };
}

/**
 * The list attrs a style's `w:pPr/w:numPr` controls (numbering reference plus
 * the baked marker-rendering attrs that `toProseDoc` normally derives from
 * `listRendering` at load time). Returns null when the style defines no
 * numbering — applying such a style leaves any existing list attrs alone, so
 * directly-applied (toolbar) lists survive a style switch the way they do in
 * Word, where numbering is not cleared by applying an unnumbered style.
 *
 * When the style does define numbering, the full attr group is reset so a
 * previous list's marker attrs never leak into the new one. Without the
 * numbering definitions the marker template can't be resolved and the painter
 * falls back to a plain decimal marker.
 *
 * The content-derived marker attrs (`listImplicitChildLevelAdvances`,
 * `listMarkerSecondSlotOffsetTwips`) are nulled — they depend on the
 * paragraph's inline LISTNUM fields, which the picker has no view of. A
 * subsequent save + reload re-derives them from the document content.
 */
export function listAttrsFromResolvedStyle(
  resolved: ResolvedParagraphStyle,
  numbering: NumberingMap | null | undefined,
): Record<string, unknown> | null {
  const numPr = resolved.paragraphFormatting?.numPr;
  if (!numPr || numPr.numId === undefined || numPr.numId === 0) {
    return null;
  }

  const rendering = numbering ? computeListRendering(numPr, numbering) : null;
  const level = numbering?.getLevel(numPr.numId, numPr.ilvl ?? 0);

  const attrs: Record<string, unknown> = {
    numPr: { numId: numPr.numId, ilvl: numPr.ilvl ?? 0 },
    // The numbering belongs to the style — mark it so a save doesn't
    // materialize a direct <w:numPr> (see ParagraphAttrs.numPrFromStyle).
    numPrFromStyle: { numId: numPr.numId, ilvl: numPr.ilvl ?? 0 },
    listNumFmt: rendering?.numFmt ?? null,
    listIsBullet: rendering?.isBullet ?? null,
    listIsLegal: rendering?.isLegal ?? null,
    listMarker: rendering?.marker ?? null,
    listMarkerHidden: rendering?.markerHidden ?? null,
    listMarkerFontFamily: rendering?.markerFontFamily ?? null,
    listMarkerFontSize: rendering?.markerFontSize ?? null,
    listMarkerSuffix: rendering?.markerSuffix ?? null,
    listMarkerAllCaps: rendering?.markerAllCaps ?? null,
    listImplicitChildLevelAdvances: null,
    listMarkerSecondSlotOffsetTwips: null,
    listLevelNumFmts: rendering?.levelNumFmts ?? null,
    listAbstractNumId: rendering?.abstractNumId ?? null,
    listStartOverride: rendering?.startOverride ?? null,
  };

  // The numbering level's own indents apply beneath the style's (ECMA-376
  // numbering pPr sits below the style in the cascade) — use them only where
  // the style doesn't specify its own indentation.
  const ppr = resolved.paragraphFormatting;
  if (level?.pPr) {
    if (ppr?.indentLeft === undefined && level.pPr.indentLeft !== undefined) {
      attrs["indentLeft"] = level.pPr.indentLeft;
    }
    const styleHasFirstLine =
      ppr?.indentFirstLine !== undefined || ppr?.hangingIndent !== undefined;
    if (!styleHasFirstLine) {
      if (level.pPr.indentFirstLine !== undefined) {
        attrs["indentFirstLine"] = level.pPr.indentFirstLine;
      }
      if (level.pPr.hangingIndent !== undefined) {
        attrs["hangingIndent"] = level.pPr.hangingIndent;
      }
    }
  }

  return attrs;
}
