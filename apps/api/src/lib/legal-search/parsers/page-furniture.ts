/**
 * Page furniture of Czech court decisions, and the sentences page breaks cut.
 *
 * A decision printed over several pages repeats a running header at the top
 * of every page after the first: "pokračování", the page number and the
 * docket, in whichever spelling the court's template used
 * ("pokračování 2 1 As 23/2012-45", "pokračování -2- 52A 35/2012",
 * "pokračování - 2 - sp. zn. 9 C 191/2025",
 * "Pokračování 3 22 Cdo 1717/2000-228"). Typewritten originals carry a bare
 * page number instead ("2", "- 2 -"). The publishers keep both where the page
 * broke, often in the middle of a sentence: the header reads as a paragraph of
 * its own, and the sentence it interrupted is cut in two.
 *
 * The word processor's own layout marks travel the same way: a soft hyphen
 * where a line may break inside a word.
 */

import { opensWithCourtParagraphMarker } from "@stll/legal-ast/court-paragraph-numbers";

/**
 * A docket as a running header prints it: "sp. zn." or "č. j." optionally,
 * the panel (absent in the letter-first registers, `Konf 4/2011`, and glued
 * to the register in some templates, `52A`), the register, number and year,
 * and the sheet.
 */
const DOCKET_PREFIX = String.raw`(?:(?:sp\.|č\.)\s*(?:zn\.|j\.)\s*)?`;
const DOCKET_SHEET = String.raw`(?:\s*-\s*\d+)?`;
const DOCKET = String.raw`${DOCKET_PREFIX}(?<headerDocket>(?:\d+\s*)?\p{Lu}\p{L}*\s*\d+\s*\/\s*\d{4})${DOCKET_SHEET}`;

/** A page number, bare or between dashes: `2`, `-2-`, `- 2 -`. */
const PAGE_NUMBER = String.raw`[-–]?\s*\d{1,3}\s*[-–]?`;

/**
 * The running header, unanchored, for a parser that composes it with page
 * furniture of its own. The docket is required: it is what keeps the word
 * "pokračování" and a number in ordinary prose from reading as a header.
 * Some templates print the docket twice, once with its sheet ("22 Cdo
 * 4223/2018 22 Cdo 4223/2018-137"); only that same docket is the header's.
 * A different one is the text of a page that opens mid-citation.
 */
export const CZ_RUNNING_HEADER_SOURCE = String.raw`[Pp]okračování\s*${PAGE_NUMBER}\s*${DOCKET}(?:\s+${DOCKET_PREFIX}\k<headerDocket>${DOCKET_SHEET})?`;

const RUNNING_HEADER_LINE_RE = new RegExp(
  String.raw`^\s*${CZ_RUNNING_HEADER_SOURCE}\s*$`,
  "u",
);
const PAGE_NUMBER_LINE_RE = new RegExp(String.raw`^\s*${PAGE_NUMBER}\s*$`, "u");

/** Whether a whole line is a running header. */
export const isRunningHeaderLine = (text: string): boolean =>
  RUNNING_HEADER_LINE_RE.test(text);

/**
 * Whether a whole line is a bare page number. Only a source that sets every
 * printed line apart can tell one from a number in the text, so a parser
 * asks this of its lines, never of paragraphs.
 */
export const isPageNumberLine = (text: string): boolean =>
  PAGE_NUMBER_LINE_RE.test(text);

/**
 * Where a sentence has ended: closing punctuation, then any closing quotes
 * or brackets.
 */
const DOCKET_PREFIX_END_RE = /č\.\s*j\.\s*$/u;
const SENTENCE_END_RE = /[.!?:;][“”"'»«)\]]*\s*$/u;
/**
 * What a cut sentence goes on with: a lowercase word, a section sign or a
 * number. A capital opens a sentence; a numbered, lettered or bulleted item
 * opens an item of a list, whatever case its text starts in ("2. žalobce
 * doložil …").
 */
const CONTINUATION_START_RE = /^\s*„?(?:\p{Ll}|§|\d)/u;
const STATUTE_NUMBER_START_RE = /^\s*č\.\s*\d/u;
const LIST_ITEM_RE = /^\s*(?:\d{1,4}[.)]|\p{L}[.)]|[-–•])\s/u;
/**
 * Shortest text a page can have cut. Short lines without closing
 * punctuation are names, labels and titles ("Josef Baxa" over "předseda
 * senátu"), never the start of a paragraph the page break interrupted.
 */
const MIN_CUT_PARAGRAPH_CHARS = 60;

/**
 * Whether `next` is the rest of the sentence `previous` breaks off in: the
 * paragraph before the page break stops mid-sentence, and the one after it
 * goes on in lowercase. A paragraph the court numbered is its own.
 */
export const continuesAcrossPageBreak = (
  previous: string,
  next: string,
): boolean =>
  previous.trim().length >= MIN_CUT_PARAGRAPH_CHARS &&
  (!SENTENCE_END_RE.test(previous) || DOCKET_PREFIX_END_RE.test(previous)) &&
  CONTINUATION_START_RE.test(next) &&
  (!LIST_ITEM_RE.test(next) || STATUTE_NUMBER_START_RE.test(next)) &&
  !opensWithCourtParagraphMarker(next);

/**
 * The soft hyphen (U+00AD) marks where a word processor may break a word at
 * the end of a line. It prints nothing unless the line breaks there, and in
 * the extracted text it cuts the word in two for search ("rozhod\u00adnutí").
 */
const SOFT_HYPHEN_RE = /\u00ad/gu;

export const withoutSoftHyphens = (text: string): string =>
  text.replace(SOFT_HYPHEN_RE, "");
