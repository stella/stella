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

/** What a caller may ask for a document's tracked changes: keep them as
 *  the changes they are, or format the text with all of them accepted or
 *  all of them rejected. */
export const REFORMAT_TRACKED_CHANGES = ["keep", "accept", "reject"] as const;

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
  /** The document's tracked changes are in the output as tracked changes;
   *  `count` is how many. Change tracking is switched off there. */
  "tracked_changes_kept",
  /** Tracked changes in paragraphs the output does not have (blank lines,
   *  the document's own table of contents); `count` is how many. */
  "tracked_changes_not_carried",
  /** Recorded changes of formatting are not carried; `count` is how many.
   *  With the changes rejected, a paragraph may show another number or
   *  bullet than the document's rejected text. */
  "formatting_changes_not_kept",
  /** The output is the text with every tracked change accepted or
   *  rejected (`reason`); `count` is how many changes that resolved. */
  "tracked_changes_resolved",
  /** A cell of the letterhead the template keeps still shows the
   *  template's sample text, because the document states nothing for it;
   *  `reason` names the cell: `addressee`, `date` or `reference`. It has
   *  to be filled in by hand. */
  "letterhead_sample_left",
  /** `count` fields of the source show their last text in the output and
   *  no longer update; `reason` lists the kinds with their counts
   *  (`REF:3,FORMCHECKBOX:2`). A form field's box or list is gone. Check
   *  them against the source. */
  "fields_as_text",
  /** The output's header or footer that `reason` names (`header:first`,
   *  `footer:default`, …) carries the document's own after the
   *  template's: `count` paragraphs, with its pictures and fields. */
  "source_header_kept",
  /** `count` headers, footers or objects of the document's have no place
   *  in the output: `reason` says which (`firstPageParts`: the output does
   *  not set its first page apart; `evenPageParts`; `sharedParts`: the
   *  template's part serves pages that take other content;
   *  `unsupportedObjects`: an embedded object other than a picture). */
  "source_header_left_out",
  /** `count` links of the document to a place in itself (a bookmark, a
   *  heading) show as plain text in the output: they no longer jump.
   *  Check them against the document. */
  "internal_links_as_text",
  /** `count` comments of the document are in the output on the text they
   *  were made on. */
  "comments_kept",
  /** `count` comments of the document were anchored where the output has
   *  no place (an omitted line, a note, a header) and are not in it. */
  "comments_left_out",
  /** A finding of the formatter this tool does not word yet; `reason`
   *  names it. */
  "other",
] as const;

export const REFORMAT_TEMPLATE_HEALTH_KINDS = [
  "number_drawn_as_picture",
  "text_drawn_as_picture",
  /** The template shows no style in use for an article heading, a clause
   *  or body text (a filled document used as a template, or numbered
   *  styles without sample text): those paragraphs were placed by
   *  fallbacks. Check the output's look; the template wants sample text in
   *  its own styles. */
  "template_roles_not_read",
  /** The template ends with sections after its body's (an exhibit, a
   *  signature page, a landscape annex): the output takes its page setup,
   *  headers and footers from the last of them. Check the output's pages. */
  "template_last_section_not_body",
  /** The template's style for article headings, clauses or party lines
   *  (`styleId`) starts every paragraph on a new page: every one of them
   *  in the output starts a page, as the template says. */
  "template_heading_starts_page",
  "other",
] as const;
