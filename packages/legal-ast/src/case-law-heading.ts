// parser-output-unchanged: [sk-courts] only the Czech parsers call these headings and items; this parser reads none of them.
// parser-output-unchanged: [sk-us] only the Czech parsers call these headings and items; this parser reads none of them.
import { romanValue } from "./heading-designator-levels.js";

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

/**
 * A title that names an act ends in the act's citation, whose collection
 * abbreviation ends in a full stop: `… podle zákona č. 128/1946 Sb.`,
 * `… č. 243/1992 Sb.`, a treaty's `Sb. m. s.`, a Slovak act's `Z. z.`.
 */
const ENDS_IN_ACT_CITATION_RE =
  /\d{1,4}\/\d{2,4}\s+(?:Sb\.(?:\s*m\.\s*s\.)?|Z\.\s*z\.)$/u;

/** Whether a title ends as a sentence does, not as an act's citation. */
const endsSentence = (title: string): boolean =>
  SENTENCE_END_RE.test(title) && !ENDS_IN_ACT_CITATION_RE.test(title);

/**
 * A finite operative verb marks a quoted or issued ruling item, never a title.
 * Appellate decisions quote the lower court's verdict as `I. Žalovaný je
 * povinen zaplatit…`.
 */
const OPERATIVE_VERB_RE =
  /(?<!\p{L})(?:je|jsou)\s+povinn\p{L}*|(?<!\p{L})se\s+(?:zamítá|zamítají|ruší|zrušuje|mění|potvrzuje|odmítá|zastavuje)(?!\p{L})|(?<!\p{L})zaplatit(?!\p{L})/iu;
const ROMAN_ITEM_RE = /^(?<numeral>(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3}))\.\s+\S/u;

/** The number of a paragraph opening with a Roman numeral, whatever follows it. */
export const romanItemNumber = (text: string): number | null => {
  const numeral = ROMAN_ITEM_RE.exec(text)?.groups?.["numeral"];
  return numeral === undefined ? null : romanValue(numeral);
};

/** A title carries no sentence end and no operative verb. */
export const isHeadingTitleShape = (title: string): boolean =>
  !endsSentence(title) && !OPERATIVE_VERB_RE.test(title);

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
    endsSentence(title)
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
  if (!isHeadingTitleShape(text.slice(text.indexOf(".") + 1).trim())) {
    return null;
  }
  return { level: match.groups?.["subsection"] === undefined ? 3 : 4 };
};
