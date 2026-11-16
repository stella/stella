/**
 * A printed table of contents: entries whose titles run into a dot leader
 * and a page number (`1. Sprzedawca Amazon EU SARL ........ 9`). It is the
 * document's navigation, not its text, so a reader may fold it away; its
 * words are kept as printed.
 *
 * Read in one pass over the characters: a leader is four dots or more, or
 * two ellipses or more, followed by the page number.
 */

/** Longest title an entry runs to before its leader. */
const ENTRY_TITLE_MAX_CHARS = 200;
const DOT_LEADER_MIN = 4;
const ELLIPSIS_LEADER_MIN = 2;
const PAGE_DIGITS_MAX = 4;

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";

/** The end of a leader and its page number at `start`, or -1. */
const leaderPageEnd = (text: string, start: number): number => {
  const mark = text[start];
  if (mark !== "." && mark !== "…") {
    return -1;
  }
  let index = start;
  while (text[index] === mark) {
    index += 1;
  }
  const minimum = mark === "." ? DOT_LEADER_MIN : ELLIPSIS_LEADER_MIN;
  if (index - start < minimum) {
    return -1;
  }
  if (text[index] === " ") {
    index += 1;
  }
  const digitsStart = index;
  while (isDigit(text[index])) {
    index += 1;
  }
  const digits = index - digitsStart;
  return digits > 0 && digits <= PAGE_DIGITS_MAX ? index : -1;
};

/** Past the run of one mark at `start`, or past the one other character. */
const afterRun = (text: string, start: number): number => {
  const mark = text[start];
  let index = start + 1;
  if (mark !== "." && mark !== "…") {
    return index;
  }
  while (text[index] === mark) {
    index += 1;
  }
  return index;
};

/**
 * Whether a block is entries of a printed table of contents: it opens on an
 * entry, and every stretch between two leaders, and the one after the last,
 * is no longer than an entry's title.
 */
export const isTableOfContentsEntry = (text: string): boolean => {
  const line = text.trim();
  let previousEnd = 0;
  let leaders = 0;
  let index = 0;
  while (index < line.length) {
    const end = leaderPageEnd(line, index);
    if (end === -1) {
      index = afterRun(line, index);
      continue;
    }
    if (index - previousEnd > ENTRY_TITLE_MAX_CHARS) {
      return false;
    }
    previousEnd = end;
    leaders += 1;
    index = end;
  }
  return leaders > 0 && line.length - previousEnd <= ENTRY_TITLE_MAX_CHARS;
};
