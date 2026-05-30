/**
 * OOXML enum schemas for parser narrowing.
 *
 * Parsers throughout this directory read string-valued XML attributes
 * (`<w:u w:val="single"/>`, `<w:pgBorders w:val="dashed"/>`, …) that
 * the document model types as a small literal union. The historical
 * pattern was `getAttribute(...) as UnderlineStyle`, which lies to
 * the type system: a malformed file produces a typed value that
 * silently contains garbage and breaks downstream consumers.
 *
 * These valibot picklists are the single source of truth for each
 * OOXML enum. `narrowEnum(value, schema)` widens a parsed string to
 * the typed enum *iff* the value is recognised; unknown values
 * become `undefined` so callers can fall back to a default, matching
 * how Word degrades when it doesn't recognise a value.
 *
 * Picklist entries are checked at compile time against the TS union
 * via `satisfies` — a new variant added to the model type fails to
 * compile until the picklist is updated, giving the same compile-time
 * coverage gate as `switch-exhaustiveness-check`.
 */

import * as v from "valibot";

import {
  BORDER_STYLE_VALUES,
  CONDITIONAL_STYLE_TYPE_VALUES,
  EMPHASIS_MARK_VALUES,
  FIELD_TYPE_VALUES,
  FLOATING_TABLE_X_SPEC_VALUES,
  FLOATING_TABLE_Y_SPEC_VALUES,
  FONT_THEME_VALUES,
  FRAME_WRAP_VALUES,
  FRAME_X_ALIGN_VALUES,
  FRAME_Y_ALIGN_VALUES,
  HIGHLIGHT_COLOR_VALUES,
  IMAGE_HORIZONTAL_ALIGNMENT_VALUES,
  IMAGE_HORIZONTAL_RELATIVE_TO_VALUES,
  IMAGE_VERTICAL_ALIGNMENT_VALUES,
  IMAGE_VERTICAL_RELATIVE_TO_VALUES,
  IMAGE_WRAP_TEXT_VALUES,
  LEVEL_SUFFIX_VALUES,
  LINE_SPACING_RULE_VALUES,
  NUMBER_FORMAT_VALUES,
  PARAGRAPH_ALIGNMENT_VALUES,
  SDT_LOCK_VALUES,
  SHADING_PATTERN_VALUES,
  SHAPE_OUTLINE_STYLE_VALUES,
  SHAPE_TYPE_VALUES,
  STYLE_TYPE_VALUES,
  TABLE_CELL_TEXT_DIRECTION_VALUES,
  TABLE_ROW_HEIGHT_RULE_VALUES,
  TABLE_WIDTH_TYPE_VALUES,
  TAB_LEADER_VALUES,
  TAB_STOP_ALIGNMENT_VALUES,
  TEXT_EFFECT_VALUES,
  THEME_COLOR_SLOT_VALUES,
  UNDERLINE_STYLE_VALUES,
} from "../types/documentEnumValues";

/**
 * Narrow a raw attribute string to a picklist member, or `undefined`
 * if the value isn't recognised. The cast lives once inside the
 * valibot output type; callers receive a properly-typed value with
 * no `as` at the call site.
 */
export const narrowEnum = <T extends string>(
  value: string | null | undefined,
  schema: v.PicklistSchema<readonly T[], undefined>,
): T | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const result = v.safeParse(schema, value);
  return result.success ? result.output : undefined;
};

// ---------------------------------------------------------------------------
// Theme & shading enums
// ---------------------------------------------------------------------------

export const ThemeColorSlotSchema = v.picklist(THEME_COLOR_SLOT_VALUES);

export const BorderStyleSchema = v.picklist(BORDER_STYLE_VALUES);

// ---------------------------------------------------------------------------
// Run formatting enums
// ---------------------------------------------------------------------------

export const UnderlineStyleSchema = v.picklist(UNDERLINE_STYLE_VALUES);

export const HighlightColorSchema = v.picklist(HIGHLIGHT_COLOR_VALUES);

export const TextEffectSchema = v.picklist(TEXT_EFFECT_VALUES);

export const EmphasisMarkSchema = v.picklist(EMPHASIS_MARK_VALUES);

export const FontThemeSchema = v.picklist(FONT_THEME_VALUES);

// ---------------------------------------------------------------------------
// Paragraph formatting enums
// ---------------------------------------------------------------------------

export const ParagraphAlignmentSchema = v.picklist(PARAGRAPH_ALIGNMENT_VALUES);

export const LineSpacingRuleSchema = v.picklist(LINE_SPACING_RULE_VALUES);

export const TabStopAlignmentSchema = v.picklist(TAB_STOP_ALIGNMENT_VALUES);

export const TabLeaderSchema = v.picklist(TAB_LEADER_VALUES);

export const FrameXAlignSchema = v.picklist(FRAME_X_ALIGN_VALUES);

export const FrameYAlignSchema = v.picklist(FRAME_Y_ALIGN_VALUES);

export const FrameWrapSchema = v.picklist(FRAME_WRAP_VALUES);

// ---------------------------------------------------------------------------
// Structured document tag (SDT) enums
// ---------------------------------------------------------------------------

export const SdtLockSchema = v.picklist(SDT_LOCK_VALUES);

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export const FieldTypeSchema = v.picklist(FIELD_TYPE_VALUES);

// ---------------------------------------------------------------------------
// Style enums
// ---------------------------------------------------------------------------

export const StyleTypeSchema = v.picklist(STYLE_TYPE_VALUES);

export const ConditionalStyleTypeSchema = v.picklist(
  CONDITIONAL_STYLE_TYPE_VALUES,
);

// ---------------------------------------------------------------------------
// Table enums
// ---------------------------------------------------------------------------

export const TableWidthTypeSchema = v.picklist(TABLE_WIDTH_TYPE_VALUES);

export const TableRowHeightRuleSchema = v.picklist(
  TABLE_ROW_HEIGHT_RULE_VALUES,
);

export const TableCellTextDirectionSchema = v.picklist(
  TABLE_CELL_TEXT_DIRECTION_VALUES,
);

// ---------------------------------------------------------------------------
// Shading enums
// ---------------------------------------------------------------------------

export const ShadingPatternSchema = v.picklist(SHADING_PATTERN_VALUES);

// ---------------------------------------------------------------------------
// Floating table position enums
// ---------------------------------------------------------------------------

export const FloatingTableXSpecSchema = v.picklist(
  FLOATING_TABLE_X_SPEC_VALUES,
);

export const FloatingTableYSpecSchema = v.picklist(
  FLOATING_TABLE_Y_SPEC_VALUES,
);

// ---------------------------------------------------------------------------
// Image positioning / wrap enums
// ---------------------------------------------------------------------------

export const ImageHorizontalRelativeToSchema = v.picklist(
  IMAGE_HORIZONTAL_RELATIVE_TO_VALUES,
);

export const ImageHorizontalAlignmentSchema = v.picklist(
  IMAGE_HORIZONTAL_ALIGNMENT_VALUES,
);

export const ImageVerticalRelativeToSchema = v.picklist(
  IMAGE_VERTICAL_RELATIVE_TO_VALUES,
);

export const ImageVerticalAlignmentSchema = v.picklist(
  IMAGE_VERTICAL_ALIGNMENT_VALUES,
);

export const ImageWrapTextSchema = v.picklist(IMAGE_WRAP_TEXT_VALUES);

// ---------------------------------------------------------------------------
// Shape outline enums
// ---------------------------------------------------------------------------

export const ShapeOutlineStyleSchema = v.picklist(SHAPE_OUTLINE_STYLE_VALUES);

export const ShapeTypeSchema = v.picklist(SHAPE_TYPE_VALUES);

// ---------------------------------------------------------------------------
// Numbering enums
// ---------------------------------------------------------------------------

export const NumberFormatSchema = v.picklist(NUMBER_FORMAT_VALUES);

export const LevelSuffixSchema = v.picklist(LEVEL_SUFFIX_VALUES);
