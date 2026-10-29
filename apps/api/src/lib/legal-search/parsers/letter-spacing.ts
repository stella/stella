// parser-output-unchanged: [cz-us] CZ-US uses default options; its recorded document and adapter outputs remain byte-identical.
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
 * shorter run (`s e`) is a spaced word beside one, across a wide gap,
 * or set apart by wide gaps within the same spaced phrase.
 * Punctuation spaced after the last letter belongs to the word.
 *
 * Some courts space short words on their own: `zákonov   n i e   j e   v`
 * (Slovak Constitutional Court). With {@link LetterSpacingOptions.setApart},
 * a short run is a spaced word too when wide gaps set it apart on both sides
 * and one of its letters is not a word of one letter (`a`, `v`, …): the
 * one run of single letters a sentence does write is a row of those words.
 */

import type { Block } from "@stll/legal-ast/document-ast";
import { plainTextOf } from "@stll/legal-ast/document-ast";
import { mapInlineText } from "@stll/legal-ast/inline-line";
import { normalizeUnicode } from "@stll/text-normalize";

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
/** Bound lookahead even for a corrupted source or an unusually long token. */
const MAX_SPACED_WORD_LENGTH = 64;

// parser-output-unchanged: the setApart rule is opt-in; callers that pass no options read text as before.
/** The words of one letter Czech and Slovak write. */
const ONE_LETTER_WORDS = new Set(["a", "i", "k", "o", "s", "u", "v", "z"]);

type LetterSpacingOptions = {
  /** Intact words from this document; permits uneven chunks, never a dictionary guess. */
  readonly attestedWords?: ReadonlySet<string>;
  /** Words independently recognized as section markers by the caller. */
  readonly spacedWords?: ReadonlySet<string>;
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

/**
 * Most words a short run may sit from a long spaced word, every gap between
 * them wide: `s e   mu   v r a c í` is one spaced phrase.
 */
const MAX_WORDS_TO_SPACED_WORD = 2;

/**
 * Whether a short run belongs to the spaced phrase of a long spaced word:
 * wide gaps on both of its sides, and a chain of wide gaps over at most
 * {@link MAX_WORDS_TO_SPACED_WORD} words to a long spaced word. A text that
 * spaces one word elsewhere ("Soud rozhodoval   i o   nákladech; … z a m í
 * t á") is no evidence for a short run in its ordinary prose.
 */
const inSpacedPhrase = (
  run: Run,
  tokens: readonly Token[],
  strongTokens: ReadonlySet<number>,
): boolean => {
  if (
    run.end === tokens.length ||
    (run.start > 0 && !isWideGap(tokens[run.start]?.gap)) ||
    !isWideGap(tokens[run.end]?.gap)
  ) {
    return false;
  }
  // Rightwards: each token reached across a wide gap.
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
  // Leftwards: each token before a wide gap.
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

/** The runs that are spaced words: long ones, nearby short ones and opt-in isolated runs. */
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
  const ordinaryRuns = new Set(
    hasOrdinaryWords || options.setApart === true
      ? runs.filter((run) =>
          tokens
            .slice(run.start, run.start + run.letters)
            .every(({ text }) =>
              ONE_LETTER_WORDS.has(
                text.replaceAll(/[.,:;!?]/gu, "").toLowerCase(),
              ),
            ),
        )
      : [],
  );
  const strongTokens = new Set(
    runs
      .filter((run) => run.letters >= STRONG_RUN_LETTERS)
      .flatMap((run) =>
        Array.from({ length: run.end - run.start }, (_, i) => run.start + i),
      ),
  );
  const spaced = runs.map(
    (run) =>
      !ordinaryRuns.has(run) &&
      (run.letters >= STRONG_RUN_LETTERS ||
        inSpacedPhrase(run, tokens, strongTokens) ||
        (options.setApart === true && isSetApartRun(tokens, run))),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [index, run] of runs.entries()) {
      if (spaced[index] === true || ordinaryRuns.has(run)) {
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

/**
 * Uneven chunks need an intact witness and a single letter Slovak cannot
 * write as a word, or an independently recognized section marker. Leave
 * all-single-letter runs to the existing reader: repairing their prefixes
 * first would hide the evidence for the rest of that run.
 */
const collapseAttestedChunks = (
  text: string,
  options: LetterSpacingOptions,
): string => {
  const { tokens, tail } = tokensOf(text);
  let result = "";
  for (let start = 0; start < tokens.length; start += 1) {
    const first = tokens[start];
    if (first === undefined) {
      continue;
    }
    let joined = "";
    let hasFragment = false;
    let hasChunk = false;
    let end = start;
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (
        token === undefined ||
        (index > start && !SINGLE_GAP_RE.test(token.gap))
      ) {
        break;
      }
      const chunk = /^(?<letters>\p{L}[\p{L}\p{M}]*)(?<mark>[.,:;!?]*)$/u.exec(
        token.text,
      );
      const letters = chunk?.groups?.["letters"];
      if (
        letters === undefined ||
        (index > start && !/^\p{Ll}/u.test(letters))
      ) {
        break;
      }
      const normalized = normalizeUnicode(letters, "NFC").toLowerCase();
      hasFragment ||=
        LETTER_RE.test(normalized) && !ONE_LETTER_WORDS.has(normalized);
      hasChunk ||= !LETTER_RE.test(normalized);
      joined += normalized;
      if (joined.length > MAX_SPACED_WORD_LENGTH) {
        break;
      }
      if (
        index > start &&
        hasChunk &&
        ((hasFragment && options.attestedWords?.has(joined) === true) ||
          options.spacedWords?.has(joined) === true)
      ) {
        end = index;
      }
      if (chunk?.groups?.["mark"] !== "") {
        break;
      }
    }
    result += first.gap;
    result += tokens
      .slice(start, end + 1)
      .map(({ text: chunk }) => chunk)
      .join("");
    const punctuation = tokens[end + 1];
    if (
      end > start &&
      punctuation !== undefined &&
      SINGLE_GAP_RE.test(punctuation.gap) &&
      TRAILING_MARK_RE.test(punctuation.text)
    ) {
      result += punctuation.text;
      end += 1;
    }
    start = end;
  }
  return result + tail;
};

export const collapseLetterSpacing = (
  text: string,
  options: LetterSpacingOptions = {},
): string => {
  const attested =
    options.attestedWords === undefined && options.spacedWords === undefined
      ? text
      : collapseAttestedChunks(text, options);
  const { tokens, tail } = tokensOf(attested);
  const spaced = spacedRunsOf(tokens, runsOf(tokens), options);
  if (spaced.length === 0) {
    return attested;
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

/** Words a text prints intact, lowercased: the witnesses for uneven chunks. */
const wordsOf = (texts: Iterable<string>): Set<string> => {
  const words = new Set<string>();
  for (const text of texts) {
    for (const [word] of text.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
      words.add(normalizeUnicode(word, "NFC").toLowerCase());
    }
  }
  return words;
};

/**
 * A decision's blocks with every word the court spaced unevenly (`m ů že`)
 * read as the word it spells, when the decision prints that word intact
 * elsewhere. The entry point for parsers that build blocks rather than lines.
 */
export const withAttestedLetterSpacing = (
  blocks: readonly Block[],
): Block[] => {
  const attestedWords = wordsOf(blocks.map(({ plainText }) => plainText));
  return blocks.map((block): Block => {
    if (block.type !== "paragraph" && block.type !== "heading") {
      return block;
    }
    const inlines = mapInlineText(block.inlines, (text) =>
      collapseLetterSpacing(text, { attestedWords }),
    );
    // The block's text is derived from its repaired inlines, never repaired
    // apart from them: a word split across formatting nodes stays as printed
    // in both. Only a changed reading replaces either.
    return plainTextOf(inlines) === plainTextOf(block.inlines)
      ? block
      : { ...block, inlines, plainText: plainTextOf(inlines).trim() };
  });
};
