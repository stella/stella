// parser-output-unchanged: [pl-sn] the paragraph helpers and their constants moved unchanged from pl-sn.ts; their positioned-line inputs and calculations are identical.
// parser-output-unchanged: [pl-kis] moved unchanged out of pl-sn.ts so the procurement reader shares it; the Supreme Court reading is the only caller in pl-sn.ts.
// parser-output-unchanged: [pl-uokik] moved unchanged out of pl-sn.ts so the procurement reader shares it; the Supreme Court reading is the only caller in pl-sn.ts.
// parser-output-unchanged: [cz-uohs] moved unchanged out of pl-sn.ts so the procurement reader shares it; the Supreme Court reading is the only caller in pl-sn.ts.
/**
 * Paragraphs read back from printed lines.
 *
 * A Polish decision that reaches a publisher as a printed page keeps one
 * signal a reader can trust: where each line starts and where it stops. A
 * first line sits past the body margin, a list point opens on its marker, and
 * a line that stopped short of the right edge ended its paragraph. The
 * Supreme Court's PDF reader measures both edges from the text layer; the
 * procurement chamber's converted pages state the start and leave the end to
 * be estimated. Both decide paragraphs here.
 */

/** Where a printed line starts and, when known, where it stops, in points. */
export type PrintedLine = {
  readonly text: string;
  readonly x: number;
  readonly right?: number | undefined;
};

/**
 * How far past the body margin a first line has to sit to read as an indent.
 *
 * The observed step is a full tab (72pt body, 108pt indent). Half of that is
 * comfortably above the sub-point jitter the extractor reports for lines that
 * begin at the same margin, and comfortably below a real indent.
 */
export const INDENT_THRESHOLD_PT = 18;

/** A list point's own number or bullet: `2.`, `IV.`, `a)`, `–`. */
const LIST_MARKER = /^(?:(?:\d{1,3}|[IVXLC]{1,6}|\p{Ll})[.)]|[-–•])\s/u;

/** A point numbered in a way no wrapped sentence starts: `2.`, `2)`, `a)`. */
const NUMBERED_POINT = /^(?:\d{1,3}[.)]|\p{Ll}\))\s/u;

/** A line ending on a unit a number follows: `art.`, `ust.`, `pkt`, `§`, `nr`. */
const TAKES_A_NUMBER =
  /(?:(?:^|\s)(?:art|ust|pkt|lit|poz|nr|zd|par|rozdz|tom|str|s|k)\.?|§)$/iu;

/** Whether a line ends on a word the number opening the next one belongs to. */
export const takesANumber = (text: string): boolean =>
  TAKES_A_NUMBER.test(text.trimEnd());

/**
 * Whether `line` opens a numbered point of its own. A numbered point opens
 * its own paragraph however full the line above ran, unless that line ended
 * on a word the number belongs to (`art.`).
 */
export const opensNumberedPoint = (
  previous: PrintedLine,
  line: PrintedLine,
): boolean =>
  NUMBERED_POINT.test(line.text.trimStart()) && !takesANumber(previous.text);

/** A line ending a sentence or a list point, closing quotes included. */
const ENDS_SENTENCE = /[.;:!?…]["”')\]]*$/u;
/** A capital, or an opening bracket or quote: also how a clerk's mark (`[SOP]`) starts. */
const STARTS_SENTENCE = /^[\p{Lu}[(„"]/u;

/**
 * Whether the line above ended only because `line`'s first word no longer
 * fit on it. A line that stopped short of that ended its paragraph.
 *
 * A short first word fits almost any gap, so a line that ended a sentence
 * before a capital or a list point is taken as the paragraph's end: two
 * paragraphs merged would hide the structure, where a missed continuation
 * only leaves the line break the reading had before.
 */
export const ranOutOfRoom = (
  previous: PrintedLine,
  line: PrintedLine,
  rightEdge: number,
): boolean => {
  const opening = line.text.trimStart();
  if (
    previous.right === undefined ||
    line.right === undefined ||
    (ENDS_SENTENCE.test(previous.text.trimEnd()) &&
      (STARTS_SENTENCE.test(opening) || LIST_MARKER.test(opening)))
  ) {
    return false;
  }
  const firstWord = opening.split(/\s/u, 1).at(0) ?? "";
  const characterWidth = (line.right - line.x) / Math.max(1, line.text.length);
  return rightEdge - previous.right < (firstWord.length + 1) * characterWidth;
};

/**
 * Whether the sentence on the line above goes on in `line`: it closes on no
 * punctuation, `line` opens on a lower-case word or a number, and the line
 * above fills at least half its measure, so it is no heading or label.
 *
 * A reader that knows line ends only roughly needs this beside
 * {@link ranOutOfRoom}: a ragged or estimated line end can look short where
 * the sentence plainly runs on.
 */
export const continuesSentence = (
  previous: PrintedLine,
  line: PrintedLine,
  rightEdge: number,
): boolean =>
  previous.right !== undefined &&
  previous.right - previous.x >= (rightEdge - previous.x) / 2 &&
  !ENDS_SENTENCE.test(previous.text.trimEnd()) &&
  /^[\p{Ll}\d]/u.test(line.text.trimStart());

/**
 * Whether `line` opens a paragraph, where the indent alone misreads blocks
 * and lists.
 *
 * An indented line carries on the full line above it when it sits no
 * deeper than that line, or when that line is a list point's first line
 * set with a hanging indent. A short line above ended its paragraph, which
 * is what keeps two one-line points of an operative part apart. A list
 * point opens a paragraph wherever it starts, though nothing indents it.
 */
export const opensBlockParagraph = (
  previous: PrintedLine | undefined,
  line: PrintedLine,
  indented: boolean,
  rightEdge: number,
): boolean => {
  if (previous === undefined || previous.text.length === 0) {
    return indented;
  }
  // Dashes, initials (`C. B.`) and abbreviations (`w. z`) wrap inside
  // sentences, so only the full-line test reads those.
  if (opensNumberedPoint(previous, line)) {
    return true;
  }
  const full = ranOutOfRoom(previous, line, rightEdge);
  if (!indented) {
    return !full && LIST_MARKER.test(line.text.trimStart());
  }
  return !(
    full &&
    (line.x - previous.x < INDENT_THRESHOLD_PT ||
      LIST_MARKER.test(previous.text.trimStart()))
  );
};
