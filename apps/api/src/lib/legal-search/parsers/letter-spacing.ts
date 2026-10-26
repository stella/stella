/**
 * Letter-spaced emphasis read back as the words it spells.
 *
 * Czech courts emphasise the operative words by spacing their letters:
 * `N á v r h   s e   z a m í t á .`, `t a k t o :`, `S T A N O V I S K O`.
 * One space separates letters, a wider gap separates words. Read as text,
 * every letter is a word of its own; collapsed blindly, the words weld
 * together (`Návrhsezamítá`). Both lose what the court wrote.
 *
 * A run of single letters joined by single spaces is a spaced word when it
 * is long enough that no sentence produces it, four letters at least. A
 * shorter run (`s e`) is a spaced word only beside one, across a wide gap,
 * or set apart by wide gaps on both sides in a text that spaces its words
 * (`a věc   s e   mu   v r a c í`). Punctuation spaced after the last letter
 * belongs to the word.
 */

type Token = {
  readonly text: string;
  /** Whitespace before the token. */
  readonly gap: string;
};

const LETTER_RE = /^\p{L}\p{M}*$/u;
/** The last letter with the word's punctuation set against it ("á."). */
const MARKED_LETTER_RE = /^\p{L}\p{M}*[.,:;!?]+$/u;
/** Punctuation spaced like one more letter ("á ."). */
const TRAILING_MARK_RE = /^[.,:;!?]+$/u;
const SINGLE_GAP_RE = /^[ \t\u00a0]$/u;
const STRONG_RUN_LETTERS = 4;
const WEAK_RUN_LETTERS = 2;

type Run = {
  /** First token of the run. */
  readonly start: number;
  /** One past the last token, trailing punctuation included. */
  readonly end: number;
  readonly letters: number;
};

const tokensOf = (text: string): { tokens: Token[]; tail: string } => {
  const tokens: Token[] = [];
  let gap = "";
  for (const match of text.matchAll(/\s+|\S+/gu)) {
    const [part] = match;
    if (/^\s/u.test(part)) {
      gap = part;
      continue;
    }
    tokens.push({ text: part, gap });
    gap = "";
  }
  return { tokens, tail: gap };
};

/** Maximal runs of single letters joined by single spaces. */
const runsOf = (tokens: readonly Token[]): Run[] => {
  const runs: Run[] = [];
  let index = 0;
  while (index < tokens.length) {
    if (!LETTER_RE.test(tokens[index]?.text ?? "")) {
      index += 1;
      continue;
    }
    const start = index;
    let letters = 1;
    index += 1;
    while (
      index < tokens.length &&
      LETTER_RE.test(tokens[index]?.text ?? "") &&
      SINGLE_GAP_RE.test(tokens[index]?.gap ?? "")
    ) {
      letters += 1;
      index += 1;
    }
    const last = tokens[index];
    if (last !== undefined && SINGLE_GAP_RE.test(last.gap)) {
      if (MARKED_LETTER_RE.test(last.text)) {
        letters += 1;
        index += 1;
      } else if (TRAILING_MARK_RE.test(last.text)) {
        index += 1;
      }
    }
    if (letters >= WEAK_RUN_LETTERS) {
      runs.push({ start, end: index, letters });
    }
  }
  return runs;
};

const isWideGap = (gap: string | undefined): boolean =>
  gap !== undefined && gap.length > 1;

/**
 * The runs that are spaced words: long ones, short ones beside them, and
 * short ones the wide word gaps of a spaced text set apart.
 */
const spacedRunsOf = (
  runs: readonly Run[],
  tokens: readonly Token[],
): Run[] => {
  const spacesWords = runs.some((run) => run.letters >= STRONG_RUN_LETTERS);
  const spaced = runs.map(
    (run) =>
      run.letters >= STRONG_RUN_LETTERS ||
      (spacesWords &&
        isWideGap(tokens[run.start]?.gap) &&
        isWideGap(tokens[run.end]?.gap)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [index, run] of runs.entries()) {
      if (spaced[index] === true) {
        continue;
      }
      const before = runs[index - 1];
      const after = runs[index + 1];
      if (
        (before !== undefined &&
          spaced[index - 1] === true &&
          before.end === run.start) ||
        (after !== undefined &&
          spaced[index + 1] === true &&
          after.start === run.end)
      ) {
        spaced[index] = true;
        changed = true;
      }
    }
  }
  return runs.filter((_, index) => spaced[index] === true);
};

export const collapseLetterSpacing = (text: string): string => {
  const { tokens, tail } = tokensOf(text);
  const spaced = spacedRunsOf(runsOf(tokens), tokens);
  if (spaced.length === 0) {
    return text;
  }
  const runAt = new Map(spaced.map((run) => [run.start, run]));
  const runEnds = new Set(spaced.map((run) => run.end));
  let result = "";
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    const run = runAt.get(index);
    // A gap touching a spaced word is a word gap, however wide.
    const gap =
      (run !== undefined || runEnds.has(index)) && token.gap !== ""
        ? " "
        : token.gap;
    if (run === undefined) {
      result += `${gap}${token.text}`;
      index += 1;
      continue;
    }
    result += `${gap}${tokens
      .slice(run.start, run.end)
      .map(({ text: letter }) => letter)
      .join("")}`;
    index = run.end;
  }
  return `${result}${tail}`;
};
