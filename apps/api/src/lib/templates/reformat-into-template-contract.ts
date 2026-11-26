/**
 * The vocabulary `reformat_into_template` answers in, apart from the rules
 * that produce it, so the chat projection reads it without the formatter.
 */

/** The tag that marks an organisation template as a house style to apply. */
export const HOUSE_STYLE_TEMPLATE_TAG = "house-style";

export const REFORMAT_NUMBERING_MODES = [
  "keep_source",
  "house_scheme",
] as const;

export const REFORMAT_REFUSAL_CODES = [
  "tracked_changes",
  "unsupported_content",
  "label_not_writable",
  "labels_not_kept",
  "template_profile_rejected",
  "verification_failed",
] as const;

export const REFORMAT_NOTE_ITEM_KINDS = [
  "reference_kept_as_text",
  "reference_suspected",
  "label_kept_as_text",
  "label_converted_to_text",
  "role_without_style",
  "articles_set_as_text",
  "page_start_not_kept",
  "page_start_moved",
  "section_layout_not_kept",
  "line_break_spacing_kept",
  "invisible_effects_removed",
  "template_blocks_kept",
] as const;

export const REFORMAT_TEMPLATE_HEALTH_KINDS = [
  "number_drawn_as_picture",
  "text_drawn_as_picture",
] as const;
