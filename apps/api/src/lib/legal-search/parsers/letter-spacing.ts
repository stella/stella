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
 * shorter run (`s e`) is a spaced word only beside one, across a wide gap.
 * Punctuation spaced after the last letter belongs to the word.
 *
 * Some courts space short words on their own: `zákonov   n i e   j e   v`
 * (Slovak Constitutional Court). With {@link LetterSpacingOptions.setApart},
 * a short run is a spaced word too when wide gaps set it apart on both sides
 * and one of its letters is not a word of one letter (`a`, `v`, …): the
 * one run of single letters a sentence does write is a row of those words.
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
const LOWERCASE_LETTER_RE = /^\p{Ll}\p{M}*$/u;

// parser-output-unchanged: the setApart rule is opt-in; callers that pass no options read text as before.
/** The words of one letter Czech and Slovak write. */
const ONE_LETTER_WORDS = new Set(["a", "i", "k", "o", "s", "u", "v", "z"]);

type LetterSpacingOptions = {
  /**
   * Read a short lowercase run set apart by wide gaps, with a letter no
   * one-letter word has, as a spaced word on its own.
   */
  readonly setApart?: boolean;
};

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

/** A gap wider than the one between two letters, or the edge of the line. */
const isWideGap = (gap: string | undefined): boolean =>
  gap === undefined || gap.length > 1;

/**
 * A short run that wide gaps set apart and that no row of words spells: in
 * lowercase, since a capital is an initial (`v L.`), and with no mark on
 * its last letter, since that is an abbreviation (`a č.`).
 */
const isSetApartRun = (tokens: readonly Token[], run: Run): boolean => {
  const letters = tokens
    .slice(run.start, run.start + run.letters)
    .map(({ text }) => text);
  return (
    isWideGap(run.start === 0 ? undefined : tokens[run.start]?.gap) &&
    isWideGap(tokens[run.end]?.gap) &&
    letters.every((letter) => LOWERCASE_LETTER_RE.test(letter)) &&
    letters.some((letter) => !ONE_LETTER_WORDS.has(letter))
  );
};

/** The runs that are spaced words: long ones, and short ones beside them. */
const spacedRunsOf = (
  tokens: readonly Token[],
  runs: readonly Run[],
  options: LetterSpacingOptions,
): Run[] => {
  const spaced = runs.map(
    (run) =>
      run.letters >= STRONG_RUN_LETTERS ||
      (options.setApart === true && isSetApartRun(tokens, run)),
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

export const collapseLetterSpacing = (
  text: string,
  options: LetterSpacingOptions = {},
): string => {
  const { tokens, tail } = tokensOf(text);
  const spaced = spacedRunsOf(tokens, runsOf(tokens), options);
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
