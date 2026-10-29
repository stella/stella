export type CaseLawSectionHeading = {
  level: 3 | 4;
};

const ROMAN_SECTION_TITLE_RE =
  /^(?:X{0,3}(?:IX|IV|V?I{0,3}))\.\s+(?:(?<subsection>\p{Lu})\)\s+)?\S.+$/u;
const SECTION_TITLE_MAX_CHARS = 180;

const LABELLED_HEADING_RE =
  /^(?<label>(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})|\d{1,2})\.(?:[^\S\n]*\n\s*|[^\S\n]+)(?<title>\p{Lu}[^\n]*)$/u;
const LABELLED_TITLE_MAX_CHARS = 120;
/** A title is not a sentence: ruling items and numbered paragraphs end in one. */
const SENTENCE_END_RE = /[.;,:!?]$/u;

export type LabelledHeading = {
  /** The numeral as printed, without its full stop: `I`, `4`. */
  label: string;
  title: string;
  /** `label. title` on one line, however the court broke it. */
  text: string;
};

/**
 * A heading printed as a numeral and a title, on one line or on two (a court
 * that sets the numeral and the title in separate elements). Callers decide
 * from layout (centred, bold, a list item) that the text is a heading; this
 * reads the text and refuses what is plainly a sentence.
 */
export const labelledHeading = (text: string): LabelledHeading | null => {
  const groups = LABELLED_HEADING_RE.exec(text.trim())?.groups;
  const label = groups?.["label"];
  const title = groups?.["title"]?.trim();
  if (
    label === undefined ||
    title === undefined ||
    title.length > LABELLED_TITLE_MAX_CHARS ||
    SENTENCE_END_RE.test(title)
  ) {
    return null;
  }
  return { label, title, text: `${label}. ${title}` };
};

/** Classify a court-authored Roman section title printed on one line. */
export const caseLawSectionHeading = (
  text: string,
): CaseLawSectionHeading | null => {
  if (text.length > SECTION_TITLE_MAX_CHARS) {
    return null;
  }
  const match = ROMAN_SECTION_TITLE_RE.exec(text);
  if (match === null) {
    return null;
  }
  return { level: match.groups?.["subsection"] === undefined ? 3 : 4 };
};
