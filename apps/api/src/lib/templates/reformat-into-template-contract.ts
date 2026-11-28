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
  /** Drawn marks of the source's page layout (dots, rules, lines placed at
   *  coordinates of that page) were left out: `count` of them, anchored in
   *  the paragraph `text` starts, or in a paragraph without words in front
   *  of it. `reason` is `paragraph_omitted` when the paragraph held
   *  nothing else and went with them. Check the place against the
   *  source. */
  "page_marks_dropped",
  /** Such marks next to the words of a signature were kept, `count` of
   *  them: one may be the line to sign on. They may stand in the wrong
   *  place. */
  "page_marks_kept",
  /** `count` fields of the source show their last text in the output and
   *  no longer update; `reason` lists the kinds with their counts
   *  (`REF:3,FORMCHECKBOX:2`). A form field's box or list is gone. Check
   *  them against the source. */
  "fields_as_text",
  /** A finding of the formatter this tool does not word yet; `reason`
   *  names it. */
  "other",
] as const;

export const REFORMAT_TEMPLATE_HEALTH_KINDS = [
  "number_drawn_as_picture",
  "text_drawn_as_picture",
  "other",
] as const;
