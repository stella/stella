/**
 * Letter-spaced emphasis read back as the words it spells.
 *
 * Courts emphasise operative words by spacing their letters:
 * `N á v r h   s e   z a m í t á .`, `t a k t o :`, `S T A N O V I S K O`,
 * `p o s t a n a w i a`. One space separates letters, a wider gap separates
 * words. Read as text, every letter is a word of its own; collapsed blindly,
 * the words weld together (`Návrhsezamítá`). Both lose what the court wrote.
 *
 * This module is the one reading of that typography. Parsers repair stored
 * text with {@link collapseLetterSpacing}; search, role vocabularies and the
 * reader fold text with {@link collapseSpacedLetters}, which is the same
 * reading with every run of spaces squeezed, and the reader and find-in-page
 * hide exactly the gaps {@link letterSpacingJoins} names. A second rule
 * anywhere else would read one heading two ways.
 *
 * Only an ASCII space joins two letters. A wider gap, a tab or a no-break
 * space separates words: a no-break space is how a court binds a one-letter
 * word to the next (`v` and `Praze`), and the files that set every word gap
 * as a no-break space do so between spaced words too.
 *
 * The rules, each on evidence the text itself carries:
 *
 * - A run of single letters joined by single spaces is a spaced word when it
 *   is long enough that no sentence writes it, four letters at least.
 * - A shorter run (`s e`) is a spaced word beside one, across wide gaps, or
 *   set apart by a wide gap in a text that spaces a long word elsewhere,
 *   unless it is a row of words a sentence writes (`i o`, `a v`): the
 *   one-letter words are conjunctions and prepositions, and a preposition
 *   takes an object, so it never stands before another one-letter word
 *   (`s a` is the spaced `sa`).
 * - Punctuation spaced after the last letter belongs to the word.
 * - With {@link LetterSpacingOptions.setApart}, a short lowercase run set
 *   apart by wide gaps on both sides is a spaced word on its own when one of
 *   its letters is not a word (`zákonov   n i e   j e   v`).
 * - With {@link LetterSpacingOptions.documentWords}, letters split into
 *   uneven chunks (`m ů že`, `p ri k azu je`) read as one word when the
 *   document prints that word whole elsewhere, or when the chunks carry a
 *   letter that is no word and pieces the document prints nowhere else, up
 *   to the gap or mark that ends the word.
 */

import { normalizeUnicode } from "./unicode.js";

type Token = {
  readonly text: string;
  /** Whitespace before the token; empty only at the start of the text. */
  readonly gap: string;
};

const LETTER_RE = /^\p{L}\p{M}*$/u;
/** The last letter with the word's punctuation set against it ("á."). */
const MARKED_LETTER_RE = /^\p{L}\p{M}*[.,:;!?]+$/u;
/** Punctuation spaced like one more letter ("á ."). */
const TRAILING_MARK_RE = /^[.,:;!?]+$/u;
const MARKS_RE = /[.,:;!?]/gu;
/** The one gap that joins two letters of a spaced word. */
const LETTER_GAP = " ";
const STRONG_RUN_LETTERS = 4;
const WEAK_RUN_LETTERS = 2;
const LOWERCASE_LETTER_RE = /^\p{Ll}\p{M}*$/u;
/** Bound lookahead even for a corrupted source or an unusually long token. */
const MAX_SPACED_WORD_LENGTH = 64;
/** A single letter, then one space, then a letter: where every run starts. */
const MAY_HOLD_RUN_RE = /(?<!\S)\p{L}\p{M}* \p{L}/u;

/**
 * The words of one letter Czech, Slovak and Polish write: the conjunctions
 * `a` and `i`, and the prepositions.
 */
const ONE_LETTER_WORDS = new Set(["a", "i", "k", "o", "s", "u", "v", "w", "z"]);
/** The one-letter words that may stand before another one-letter word. */
const ONE_LETTER_CONJUNCTIONS = new Set(["a", "i"]);

export type LetterSpacingOptions = {
  /**
   * How many times the document prints each word, lowercased in NFC (see
   * {@link documentWordCounts}). Permits uneven chunks; never a dictionary
   * guess.
   */
  readonly documentWords?: ReadonlyMap<string, number>;
  /** Words independently recognized as section markers by the caller. */
  readonly spacedWords?: ReadonlySet<string>;
  /**
   * Read a short lowercase run set apart by wide gaps, with a letter no
   * one-letter word has, as a spaced word on its own.
   */
  readonly setApart?: boolean;
  /**
   * The source sets this text apart as letter-spaced emphasis as a whole
   * (one formatting node per letter): every run of single letters in it is
   * a spaced word, however short. See {@link isLetterSpacedEmphasis}.
   */
  readonly emphasis?: boolean;
};

type Run = {
  /** First token of the run. */
  readonly start: number;
  /** One past the last token, trailing punctuation included. */
  readonly end: number;
  readonly letters: number;
  /** Whether the run's last letter or a token after it is punctuation. */
  readonly marked: boolean;
};

const wordKey = (word: string): string =>
  normalizeUnicode(word, "NFC").toLowerCase();

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

/** A gap other than the one between two letters, or the edge of the text. */
const isWideGap = (gap: string | undefined): boolean =>
  gap === undefined || gap !== LETTER_GAP;

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
    let marked = false;
    index += 1;
    while (
      index < tokens.length &&
      LETTER_RE.test(tokens[index]?.text ?? "") &&
      tokens[index]?.gap === LETTER_GAP
    ) {
      letters += 1;
      index += 1;
    }
    const last = tokens[index];
    if (last?.gap === LETTER_GAP) {
      if (MARKED_LETTER_RE.test(last.text)) {
        letters += 1;
        index += 1;
        marked = true;
      } else if (TRAILING_MARK_RE.test(last.text)) {
        index += 1;
        marked = true;
      }
    }
    if (letters >= WEAK_RUN_LETTERS) {
      runs.push({ start, end: index, letters, marked });
    }
  }
  return runs;
};

const lettersOf = (tokens: readonly Token[], run: Run): string[] =>
  tokens
    .slice(run.start, run.start + run.letters)
    .map(({ text }) => text.replaceAll(MARKS_RE, "").toLowerCase());

/**
 * Whether a run's letters are words a sentence writes in a row: one-letter
 * words, each but the last a conjunction (`a v`, `i o`, `a i v`).
 */
const isRowOfWords = (letters: readonly string[]): boolean =>
  letters.every(
    (letter, index) =>
      ONE_LETTER_WORDS.has(letter) &&
      (index === letters.length - 1 || ONE_LETTER_CONJUNCTIONS.has(letter)),
  );

/**
 * A short run that wide gaps set apart and that no row of words spells: in
 * lowercase, since a capital is an initial (`v L.`), and with no mark on
 * its last letter, since that is an abbreviation (`a č.`).
 */
const isSetApartRun = (tokens: readonly Token[], run: Run): boolean => {
  const letters = lettersOf(tokens, run);
  return (
    isWideGap(run.start === 0 ? undefined : tokens[run.start]?.gap) &&
    isWideGap(tokens[run.end]?.gap) &&
    !run.marked &&
    tokens
      .slice(run.start, run.start + run.letters)
      .every(({ text }) => LOWERCASE_LETTER_RE.test(text)) &&
    letters.some((letter) => !ONE_LETTER_WORDS.has(letter))
  );
};

/**
 * A short run in a text that spaces a long word elsewhere: lowercase, no
 * mark on its last letter, a wide gap on at least one side, and not a row
 * of words. A file's text layer keeps the gaps only roughly (`Žalobcovi
 * s a náhrada …  n e p r i z n á v a.`), so one side is enough.
 */
const isShortRunOfSpacedText = (tokens: readonly Token[], run: Run): boolean =>
  !run.marked &&
  (isWideGap(run.start === 0 ? undefined : tokens[run.start]?.gap) ||
    isWideGap(tokens[run.end]?.gap)) &&
  tokens
    .slice(run.start, run.start + run.letters)
    .every(({ text }) => LOWERCASE_LETTER_RE.test(text)) &&
  !isRowOfWords(lettersOf(tokens, run));

/**
 * Most words a short run may sit from a long spaced word, every gap between
 * them wide: `s e   mu   v r a c í` is one spaced phrase.
 */
const MAX_WORDS_TO_SPACED_WORD = 2;

/**
 * Whether a short run belongs to the spaced phrase of a long spaced word:
 * no mark on its last letter (`v r.` is an abbreviation), wide gaps on both
 * of its sides, and a chain of wide gaps over at most
 * {@link MAX_WORDS_TO_SPACED_WORD} words to a long spaced word.
 */
const inSpacedPhrase = (
  run: Run,
  tokens: readonly Token[],
  strongTokens: ReadonlySet<number>,
): boolean => {
  if (
    run.marked ||
    run.end === tokens.length ||
    (run.start > 0 && !isWideGap(tokens[run.start]?.gap)) ||
    !isWideGap(tokens[run.end]?.gap)
  ) {
    return false;
  }
  for (
    let index = run.end;
    index < tokens.length && index <= run.end + MAX_WORDS_TO_SPACED_WORD;
    index++
  ) {
    if (!isWideGap(tokens[index]?.gap)) {
      break;
    }
    if (strongTokens.has(index)) {
      return true;
    }
  }
  for (
    let index = run.start;
    index > 0 && index >= run.start - MAX_WORDS_TO_SPACED_WORD;
    index--
  ) {
    if (!isWideGap(tokens[index]?.gap)) {
      break;
    }
    if (strongTokens.has(index - 1)) {
      return true;
    }
  }
  return false;
};

/** The runs that are spaced words. */
const spacedRunsOf = (
  tokens: readonly Token[],
  runs: readonly Run[],
  options: LetterSpacingOptions,
): Run[] => {
  const hasOrdinaryWords = tokens.some(
    ({ text }) =>
      !LETTER_RE.test(text) &&
      !MARKED_LETTER_RE.test(text) &&
      !TRAILING_MARK_RE.test(text),
  );
  // In a text that is all single letters there is no prose to protect.
  const ordinaryRuns = new Set(
    hasOrdinaryWords || options.setApart === true
      ? runs.filter((run) => isRowOfWords(lettersOf(tokens, run)))
      : [],
  );
  const strongRuns = runs.filter(
    (run) => run.letters >= STRONG_RUN_LETTERS && !ordinaryRuns.has(run),
  );
  const strongTokens = new Set(
    strongRuns.flatMap((run) =>
      Array.from({ length: run.end - run.start }, (_, i) => run.start + i),
    ),
  );
  const spacesWords = strongRuns.length > 0;
  const spaced = runs.map(
    (run) =>
      options.emphasis === true ||
      (!ordinaryRuns.has(run) &&
        (run.letters >= STRONG_RUN_LETTERS ||
          inSpacedPhrase(run, tokens, strongTokens) ||
          (spacesWords && isShortRunOfSpacedText(tokens, run)) ||
          (options.setApart === true && isSetApartRun(tokens, run)))),
  );
  // A run right beside a spaced word, across a wide gap, is part of the
  // spaced phrase. One pass each way reaches every chain.
  const joinsNeighbour = (index: number, neighbour: number): boolean => {
    const run = runs[index];
    const other = runs[neighbour];
    if (
      run === undefined ||
      other === undefined ||
      spaced[neighbour] !== true ||
      ordinaryRuns.has(run)
    ) {
      return false;
    }
    const [left, right] = neighbour < index ? [other, run] : [run, other];
    return left.end === right.start && isWideGap(tokens[right.start]?.gap);
  };
  for (let index = 1; index < runs.length; index++) {
    if (spaced[index] !== true && joinsNeighbour(index, index - 1)) {
      spaced[index] = true;
    }
  }
  for (let index = runs.length - 2; index >= 0; index--) {
    if (spaced[index] !== true && joinsNeighbour(index, index + 1)) {
      spaced[index] = true;
    }
  }
  return runs.filter((_, index) => spaced[index] === true);
};

const CHUNK_RE = /^(?<letters>\p{L}[\p{L}\p{M}]*)(?<mark>[.,:;!?]*)$/u;

type Chunk = { readonly letters: string; readonly mark: string };

const chunkOf = (token: Token | undefined): Chunk | undefined => {
  const groups = CHUNK_RE.exec(token?.text ?? "")?.groups;
  const letters = groups?.["letters"];
  return letters === undefined
    ? undefined
    : { letters, mark: groups?.["mark"] ?? "" };
};

/** Letters, not code units: a decomposed `ú` is one letter. */
const letterCount = (text: string): number =>
  text.match(/\p{L}/gu)?.length ?? 0;

/** A letter standing alone that no one-letter word spells: a piece of one. */
const isFragment = (letters: string): boolean =>
  LOWERCASE_LETTER_RE.test(letters) && !ONE_LETTER_WORDS.has(wordKey(letters));

/** Fewest chunks an unattested uneven word has; `x denně` is two words. */
const MIN_UNATTESTED_CHUNKS = 3;

/**
 * Most letters one piece of an unattested uneven word has. The pieces a
 * file's text layer cuts a spaced word into are short (`azu`, `evyh`,
 * `ôvod`); a longer word the document prints once is ordinary prose.
 */
const MAX_UNATTESTED_PIECE_LETTERS = 5;

/** Most letters the first piece has when it is not a fragment (`Pou`). */
const MAX_LEADING_PIECE_LETTERS = 3;

/**
 * Whether the chunks read as one word the document never prints whole:
 * they carry a fragment, at least two pieces are fragments or printed
 * nowhere else, every piece is short and every piece longer than two
 * letters is printed nowhere else, and the first piece is no word of the
 * document. The caller has checked that a gap or a mark ends them.
 */
const isUnattestedSpacedWord = (
  chunks: readonly Chunk[],
  counts: ReadonlyMap<string, number>,
): boolean => {
  const rare = (letters: string) => (counts.get(wordKey(letters)) ?? 0) <= 1;
  const size = letterCount;
  const [first] = chunks;
  if (first === undefined || chunks.length < MIN_UNATTESTED_CHUNKS) {
    return false;
  }
  const pieces = chunks.filter(
    ({ letters }) =>
      isFragment(letters) || (size(letters) > 1 && rare(letters)),
  );
  return (
    chunks.some(({ letters }) => isFragment(letters)) &&
    chunks.some(({ letters }) => size(letters) > 1) &&
    pieces.length >= 2 &&
    chunks.every(
      ({ letters }) =>
        size(letters) <= MAX_UNATTESTED_PIECE_LETTERS &&
        (size(letters) <= 2 || rare(letters)),
    ) &&
    (isFragment(first.letters) ||
      (size(first.letters) > 1 &&
        size(first.letters) <= MAX_LEADING_PIECE_LETTERS &&
        rare(first.letters))) &&
    chunks.reduce((sum, { letters }) => sum + size(letters), 0) >=
      STRONG_RUN_LETTERS
  );
};

/**
 * Whether a word starts at `start`: at the edge of the text, after a wide
 * gap or a mark, or after a word the document prints more than once. A
 * piece the document prints nowhere else before it (`poru šen é`) means the
 * word started earlier.
 */
const opensWord = (
  tokens: readonly Token[],
  start: number,
  counts: ReadonlyMap<string, number>,
): boolean => {
  const previous = chunkOf(tokens[start - 1]);
  return (
    start === 0 ||
    tokens[start]?.gap !== LETTER_GAP ||
    previous?.mark !== "" ||
    (counts.get(wordKey(previous.letters)) ?? 0) > 1
  );
};

type ChunkRead = {
  readonly chunks: readonly Chunk[];
  /** The last chunk of the longest attested reading; `start` when none. */
  readonly attestedEnd: number;
  /** Whether a gap, a mark or the end of the text ends the chunks. */
  readonly closed: boolean;
};

/** The chunks joined by single spaces from `start`, as far as one word goes. */
const readChunks = (
  tokens: readonly Token[],
  start: number,
  options: LetterSpacingOptions,
): ChunkRead => {
  const chunks: Chunk[] = [];
  let joined = "";
  let hasFragment = false;
  let hasChunk = false;
  let attestedEnd = start;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || (index > start && token.gap !== LETTER_GAP)) {
      return { chunks, attestedEnd, closed: true };
    }
    const chunk = chunkOf(token);
    if (
      chunk === undefined ||
      (index > start && !/^\p{Ll}/u.test(chunk.letters))
    ) {
      // A trailing mark set one space apart still ends the word.
      return { chunks, attestedEnd, closed: TRAILING_MARK_RE.test(token.text) };
    }
    chunks.push(chunk);
    const normalized = wordKey(chunk.letters);
    hasFragment ||=
      LETTER_RE.test(normalized) && !ONE_LETTER_WORDS.has(normalized);
    hasChunk ||= !LETTER_RE.test(normalized);
    joined += normalized;
    if (joined.length > MAX_SPACED_WORD_LENGTH) {
      return { chunks, attestedEnd, closed: false };
    }
    if (
      index > start &&
      hasChunk &&
      ((hasFragment && (options.documentWords?.get(joined) ?? 0) > 0) ||
        options.spacedWords?.has(joined) === true)
    ) {
      attestedEnd = index;
    }
    if (chunk.mark !== "") {
      return { chunks, attestedEnd, closed: true };
    }
  }
  return { chunks, attestedEnd, closed: true };
};

/**
 * Uneven chunks need an intact witness and a single letter no one-letter
 * word spells, an independently recognized section marker, or the shape of
 * {@link isUnattestedSpacedWord}. Leave all-single-letter runs to the run
 * reader: repairing their prefixes first would hide the evidence for the
 * rest of that run.
 */
const collapseUnevenChunks = (
  text: string,
  options: LetterSpacingOptions,
): string => {
  const { tokens, tail } = tokensOf(text);
  const counts = options.documentWords;
  let result = "";
  for (let start = 0; start < tokens.length; start += 1) {
    const first = tokens[start];
    if (first === undefined) {
      continue;
    }
    const { chunks, attestedEnd, closed } = readChunks(tokens, start, options);
    // The whole word up to the gap or mark that ends it, over a short
    // attested prefix (`p ri k azu je` is `prikazuje`, not `pri k azu je`);
    // a whole word the document prints (`m ů že` is `může`) stands.
    const attestedLetters = chunks
      .slice(0, attestedEnd - start + 1)
      .reduce((sum, { letters }) => sum + letterCount(letters), 0);
    const unattested =
      counts !== undefined &&
      closed &&
      (attestedEnd === start || attestedLetters < STRONG_RUN_LETTERS) &&
      opensWord(tokens, start, counts) &&
      isUnattestedSpacedWord(chunks, counts);
    let end = unattested ? start + chunks.length - 1 : attestedEnd;
    result += first.gap;
    result += tokens
      .slice(start, end + 1)
      .map(({ text: chunk }) => chunk)
      .join("");
    const punctuation = tokens[end + 1];
    if (
      end > start &&
      punctuation?.gap === LETTER_GAP &&
      TRAILING_MARK_RE.test(punctuation.text)
    ) {
      result += punctuation.text;
      end += 1;
    }
    start = end;
  }
  return result + tail;
};

/**
 * Whitespace beside a spaced word is one word gap. Only a gap of plain
 * spaces narrows: a tab or a no-break space is kept as printed.
 */
const wordGap = (gap: string): string => (/^ +$/u.test(gap) ? " " : gap);

/**
 * The text with every letter-spaced word read as the word it spells. Only
 * whitespace changes: a gap inside a spaced word is removed, a run of spaces
 * beside one becomes one space.
 */
export const collapseLetterSpacing = (
  text: string,
  options: LetterSpacingOptions = {},
): string => {
  const uneven =
    options.documentWords === undefined && options.spacedWords === undefined
      ? text
      : collapseUnevenChunks(text, options);
  if (!MAY_HOLD_RUN_RE.test(uneven)) {
    return uneven;
  }
  const { tokens, tail } = tokensOf(uneven);
  const spaced = spacedRunsOf(tokens, runsOf(tokens), options);
  if (spaced.length === 0) {
    return uneven;
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
    const gap =
      (run !== undefined || runEnds.has(index)) && token.gap !== ""
        ? wordGap(token.gap)
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

/**
 * Whether a text is letter-spaced as a whole: single letters apart, the
 * last perhaps with its punctuation (`n e p ř i z n á v á .`, `s e`).
 * Callers read a node of the source this way to pass
 * {@link LetterSpacingOptions.emphasis}.
 */
export const isLetterSpacedEmphasis = (text: string): boolean => {
  const { tokens } = tokensOf(text);
  const last = tokens.at(-1);
  const letters =
    last !== undefined && TRAILING_MARK_RE.test(last.text)
      ? tokens.slice(0, -1)
      : tokens;
  return (
    letters.length >= WEAK_RUN_LETTERS &&
    letters.every(
      ({ text: token }, index) =>
        LETTER_RE.test(token) ||
        (index === letters.length - 1 && MARKED_LETTER_RE.test(token)),
    )
  );
};

/**
 * How many times the texts print each word, lowercased in NFC: the evidence
 * {@link LetterSpacingOptions.documentWords} reads.
 */
export const documentWordCounts = (
  texts: Iterable<string>,
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const [word] of text.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
      const key = wordKey(word);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
};

/** A gap between two letters, and which space sets it. */
const LETTER_GAP_RE = /\p{L}\p{M}*(?<gap>[ \u00a0])(?=\p{L})/gu;

/**
 * How many gaps between two letters the texts set as a plain space, and how
 * many as a no-break space: a file that sets its word gaps as no-break
 * spaces tells itself apart this way (see {@link joinWordSeams}).
 */
export const letterGapCounts = (
  texts: Iterable<string>,
): { plain: number; noBreak: number } => {
  let plain = 0;
  let noBreak = 0;
  for (const text of texts) {
    for (const match of text.matchAll(LETTER_GAP_RE)) {
      if (match.groups?.["gap"] === " ") {
        plain += 1;
      } else {
        noBreak += 1;
      }
    }
  }
  return { plain, noBreak };
};

/**
 * A seam inside a word: a letter (with at most a few combining marks), then
 * the lowercase rest of the word. Bounded repeats keep every match linear.
 */
const WORD_SEAM_RE = /(?<=\p{L}\p{M}{0,4}) (?=\p{Ll})/gu;

/** The word that ends a text, and the one that opens it, at most 64 letters. */
const LAST_WORD_RE = /\p{L}[\p{L}\p{M}]{0,63}$/u;
const FIRST_WORD_RE = /^\p{L}[\p{L}\p{M}]{0,63}/u;

/**
 * A text with each plain space inside a word removed, for a file that sets
 * every word gap as a no-break space: there a plain space is a seam where
 * the text layer joined two runs of one spaced word (`zru šuje`, `Pou
 * čenie:`). A plain space between two words the file prints whole
 * (`wholeWords`, lowercased in NFC) is a gap the court set (`v súde`), and
 * stays.
 */
export const joinWordSeams = (
  text: string,
  wholeWords: ReadonlySet<string>,
): string =>
  text.replaceAll(WORD_SEAM_RE, (seam: string, offset: number) => {
    const before = LAST_WORD_RE.exec(
      text.slice(Math.max(0, offset - 64), offset),
    );
    const after = FIRST_WORD_RE.exec(text.slice(offset + 1, offset + 65));
    return before !== null &&
      after !== null &&
      wholeWords.has(wordKey(before[0])) &&
      wholeWords.has(wordKey(after[0]))
      ? seam
      : "";
  });

const SPACES_RE = / {2,}/gu;

const foldPass = (text: string): string =>
  collapseLetterSpacing(text).replaceAll(SPACES_RE, " ");

// Single-entry cache: the role vocabularies re-fold the same line text in
// sequence while classifying it. A pure function, so caching only the most
// recent call is always correct.
let lastInput: string | undefined;
let lastResult: string | undefined;

/**
 * The search and comparison form of a text: {@link collapseLetterSpacing}
 * with every run of spaces squeezed to one, applied until it settles.
 *
 * Applied to a fixpoint, so `f(f(x)) === f(x)`: a run written with two
 * spaces between its letters only shows once the squeeze has run, and the
 * index side and the query side are folded at different times, the query
 * side often over text the index side already folded.
 */
export const collapseSpacedLetters = (text: string): string => {
  if (text === lastInput && lastResult !== undefined) {
    return lastResult;
  }
  let result = text;
  for (;;) {
    const next = foldPass(result);
    // Terminates: a pass that changes anything strictly shortens the text.
    if (next === result) {
      break;
    }
    result = next;
  }
  lastInput = text;
  lastResult = result;
  return result;
};

const WHITESPACE_RE = /\s/u;

/**
 * The indices of `text` whose whitespace {@link collapseSpacedLetters}
 * removes outright: the gaps inside letter-spaced words, in order. A reader
 * that leaves these undrawn, and squeezes the rest as a browser does, draws
 * the folded text; find-in-page reads them as joins rather than as word
 * boundaries.
 */
export const letterSpacingJoins = (text: string): number[] => {
  const folded = collapseSpacedLetters(text);
  if (folded === text) {
    return [];
  }
  const joins: number[] = [];
  let source = 0;
  let target = 0;
  while (source < text.length) {
    if (!WHITESPACE_RE.test(text.charAt(source))) {
      source += 1;
      target += 1;
      continue;
    }
    const gapStart = source;
    while (source < text.length && WHITESPACE_RE.test(text.charAt(source))) {
      source += 1;
    }
    let kept = 0;
    while (
      target < folded.length &&
      WHITESPACE_RE.test(folded.charAt(target))
    ) {
      target += 1;
      kept += 1;
    }
    if (kept === 0) {
      for (let index = gapStart; index < source; index += 1) {
        joins.push(index);
      }
    }
  }
  return joins;
};
