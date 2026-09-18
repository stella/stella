import { collapseSpacedLetters } from "@stll/text-normalize";

/**
 * How a Slovak court decision names its own parts.
 *
 * Shared because one court publishes the same decision twice, as a file and
 * as markup, and the two renderings carry the same words with different
 * typography: the file spaces a section marker out with bold glyphs, the
 * markup spaces it out with literal spaces. A parser per rendering that
 * spelled the vocabulary itself would drift the day a court added a form of
 * words, and only one of the two would learn it.
 *
 * Every predicate takes a line as printed and reads it with its spacing
 * removed, so `r o z h o d o l :`, `rozh od ol :` and `rozhodol:` are one
 * marker. Both renderings space these words out, and neither does it a
 * letter at a time: the file and the markup are justified text, and the
 * gaps fall wherever the line needed them.
 */

/**
 * Decision type names that appear as a standalone title line, spelled the
 * way {@link normalized} reads a line: the comparison is against a line
 * with its spacing removed, so the vocabulary carries none either.
 */
const DECISION_TITLES = new Set([
  "uznesenie",
  "rozsudok",
  "rozsudokbezodôvodnenia",
  "trestnýrozkaz",
  "príkaz",
  "rozhodnutie",
  "uzneseniebezodôvodnenia",
]);

const HOLDING_MARKERS = ["rozhodol:", "rozhodla:", "rozhodlo:"];

const REASONING_MARKER = "odôvodnenie:";

const INSTRUCTION_MARKER = "poučenie:";

/**
 * A holding marker is the only one matched at the end of a line rather
 * than anchored at its start, so it is the only one that needs a length to
 * bound it: the court closes its preamble with `… takto` and prints the
 * marker on the next line, and a paragraph quoting the word would
 * otherwise read as a heading.
 */
const MARKER_LINE_MAX_CHARS = 40;

const normalized = (text: string): string =>
  collapseSpacedLetters(text.toLowerCase()).replaceAll(/\s+/gu, "");

export const isSkDecisionTitle = (text: string): boolean =>
  DECISION_TITLES.has(normalized(text));

export const isSkHoldingMarker = (text: string): boolean => {
  if (text.trim().length > MARKER_LINE_MAX_CHARS) {
    return false;
  }
  const norm = normalized(text);
  return HOLDING_MARKERS.some((marker) => norm.endsWith(marker));
};

export const isSkReasoningMarker = (text: string): boolean =>
  normalized(text) === REASONING_MARKER;

/**
 * `startsWith`: this court prints `Poučenie:` with its sentence on the
 * same line rather than as a heading of its own.
 */
export const isSkInstructionMarker = (text: string): boolean =>
  normalized(text).startsWith(INSTRUCTION_MARKER);

/** Whether the instruction marker stands alone, with no sentence after it. */
export const isSkStandaloneInstructionMarker = (text: string): boolean =>
  normalized(text) === INSTRUCTION_MARKER;

/**
 * Closing formula:
 *   `V {City} dňa ...`   (obcan.justice.sk)
 *   `V {City} {date}`    (ustavnysud.sk, no `dňa`)
 *   `Vo {City} ...`      (locative variant)
 */
export const SK_CLOSING_RE = /^Vo?\s+\p{Lu}\p{Ll}+\s+(?:dňa\s|\d{1,2}\.\s)/u;

/** Judge signature: an academic title opens the line. */
export const SK_JUDGE_TITLE_RE =
  /^(?:JUDr\.|Mgr\.|doc\.|Ing\.|PhDr\.|RNDr\.|MUDr\.|PaedDr\.)\s/u;

/** A standalone Roman numeral, which this court uses as a part divider. */
export const SK_ROMAN_DIVIDER_RE = /^(?:I{1,3}|IV|VI{0,3}|IX|X{1,3})\.$/u;
