import type { BlockKey } from "./block-ids";

/** A printed section number: `2`, `2.4`, `2.4.1.` */
const SECTION_NUMBER = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?(?=\s)/u;

/** A named division with its own designation: `Annex II`, `Příloha č. 1`. */
const NAMED_DIVISION =
  /^((?:annex|appendix|chapter|part|section|příloha|kapitola|část|oddíl)(?:\s+č\.)?\s+[\dIVXLC]{1,6})\b/iu;

/** Long enough to tell headings apart, short enough to read in a URL. */
const MAX_TEXT_LABEL_LENGTH = 48;

/**
 * The key of a heading: its printed designation when it has one, so the id
 * survives a retitled heading, and otherwise its text, so the id survives
 * a heading inserted before it.
 */
export const headingKeyOf = (text: string): BlockKey => {
  const label =
    SECTION_NUMBER.exec(text)?.at(1) ??
    NAMED_DIVISION.exec(text)?.at(1) ??
    text.slice(0, MAX_TEXT_LABEL_LENGTH);
  return { type: "section", label };
};
