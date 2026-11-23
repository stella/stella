/**
 * Learns the fixes a person makes to dictated text. What a dictation put in
 * a field is compared, word by word, with the text the person finally sent
 * or saved; a word or short phrase they replaced with a close spelling is a
 * correction. One seen twice the same way, and never taken back, becomes a
 * fix applied to every later dictation. Pure: no storage, no clock.
 *
 * Only small fixes count: at most three words on either side, letters close
 * to the dictated ones, nothing with digits, and none that adds or drops a
 * part of a word, as "ne" in Czech turns a word into its negation. A
 * dictation rewritten for more than half of its words teaches nothing.
 */
import { casedLike, distance, fold, splitWords } from "./spelling";

export const LEARNED_FIX_STATUSES = [
  /** Seen once; not applied yet. */
  "learning",
  /** Applied to every dictation. */
  "on",
  /** Switched off by the person. */
  "off",
  /** Corrected another way, or kept as dictated: never applied. */
  "contradicted",
] as const;

export type LearnedFixStatus = (typeof LEARNED_FIX_STATUSES)[number];

export type LearnedFix = {
  /** The words as dictated. */
  readonly from: string;
  /** The words as the person wrote them. */
  readonly to: string;
  /** How many dictations were corrected this way. */
  readonly seen: number;
  readonly status: LearnedFixStatus;
};

/** How many fixes are kept; the oldest not in use go first. */
export const LEARNED_FIX_LIMIT = 30;
/** The longest side of a fix, in UTF-16 units. */
export const LEARNED_FIX_TEXT_LIMIT = 48;
/** Corrections seen before a fix applies itself. */
const SIGHTINGS_TO_APPLY = 2;
/** The most words on either side of one fix. */
const MAX_FIX_WORDS = 3;
/** Shorter fixes, in letters, are too likely to be different words. */
const MIN_FIX_LETTERS = 4;
/** Larger comparisons are skipped: no learning beats a slow send. */
const MAX_DIFF_CELLS = 250_000;

/** A field's text right after a dictation went in, and where it went. */
export type DictatedSpan = {
  readonly text: string;
  /** Where the dictated text starts in `text`, in UTF-16 units. */
  readonly start: number;
  readonly end: number;
};

/** What the person did to one dictation. */
export type DictationEdits = {
  /** Words they replaced with a close spelling. */
  readonly corrections: readonly { from: string; to: string }[];
  /**
   * Runs of dictated words, as written, they left alone in a dictation
   * they otherwise edited: words they read and kept. Empty when they
   * changed nothing, since then they may not have read it.
   */
  readonly kept: readonly (readonly string[])[];
};

const NO_EDITS: DictationEdits = { corrections: [], kept: [] };

/** What became of the dictated words of `span` in `final`, the text sent or saved. */
export const editsOf = (span: DictatedSpan, final: string): DictationEdits => {
  const before = wordsOf(span.text);
  const first = before.findIndex(({ start }) => start >= span.start);
  const end = before.filter(({ end: wordEnd }) => wordEnd <= span.end).length;
  if (first === -1 || end <= first) {
    return NO_EDITS;
  }
  const after = wordsOf(final);
  // Compared as written, so a capital inside a word ("McKenzie") counts.
  const hunks = wordHunks(
    before.map(({ exact }) => exact),
    after.map(({ exact }) => exact),
  );
  if (hunks === undefined) {
    return NO_EDITS;
  }
  const inside = hunks.filter(
    ({ old }) =>
      (old.start < end && old.end > first) ||
      (old.start === old.end && old.start > first && old.start < end),
  );
  if (inside.length === 0) {
    return NO_EDITS;
  }
  const count = end - first;
  const changed = inside.reduce(
    (sum, { old, next }) =>
      sum + Math.max(old.end - old.start, next.end - next.start),
    0,
  );
  if (changed > Math.max(1, Math.floor(count / 2))) {
    return NO_EDITS;
  }
  const corrections = inside.flatMap(({ old, next }) => {
    const oldCount = old.end - old.start;
    const nextCount = next.end - next.start;
    if (
      old.start < first ||
      old.end > end ||
      oldCount === 0 ||
      nextCount === 0 ||
      oldCount > MAX_FIX_WORDS ||
      nextCount > MAX_FIX_WORDS
    ) {
      return [];
    }
    const from = asWritten(before.slice(old.start, old.end), span.text);
    const to = asWritten(after.slice(next.start, next.end), final);
    return isCorrection(from, to) ? [{ from, to }] : [];
  });
  return { corrections, kept: keptRuns(before, inside, { first, end }) };
};

/** `fixes` after what the person did to one dictation. */
export const learnFrom = (
  fixes: readonly LearnedFix[],
  { corrections, kept }: DictationEdits,
): LearnedFix[] => {
  let next = [...fixes];
  // The same correction twice in one dictation is one sighting.
  const distinct = new Map(
    corrections.map((correction) => [
      `${correction.from}\u0000${correction.to}`,
      correction,
    ]),
  );
  for (const { from, to } of distinct.values()) {
    const fromKey = phraseKey(from);
    // The person turned a fix's words back: it was wrong.
    next = next.map((fix) =>
      turnsBack(fix, { from, to }) ? contradicted(fix) : fix,
    );
    const known = next.find((fix) => phraseKey(fix.from) === fromKey);
    const updated =
      known === undefined ? firstSighting(from, to) : sighted(known, to);
    next = [...next.filter((fix) => fix !== known), updated];
  }
  next = next.map((fix) =>
    kept.some((run) => keptAsDictated(run, fix)) ? contradicted(fix) : fix,
  );
  while (next.length > LEARNED_FIX_LIMIT) {
    const unused = next.findIndex(
      ({ status }) => status === "learning" || status === "contradicted",
    );
    next.splice(Math.max(unused, 0), 1);
  }
  return next;
};

/** `text` with the words of every fix that is on written as the person writes them. */
export const applyLearnedFixes = (
  text: string,
  fixes: readonly LearnedFix[],
): string => {
  const active = fixes
    .filter(({ status, from }) => status === "on" && wordsOnly(from))
    .map(({ from, to }) => ({ keys: phraseKey(from).split(" "), to }))
    // The longest phrase first, so it wins over one of its words.
    .sort((left, right) => right.keys.length - left.keys.length);
  if (active.length === 0) {
    return text;
  }
  const pieces = splitWords(text);
  let out = "";
  let index = 0;
  for (
    let piece = pieces.at(0);
    piece !== undefined;
    piece = pieces.at(index)
  ) {
    // Only a word starts a match: what lies before it stays.
    const match =
      piece.kind === "word" ? fixAt(pieces, index, active) : undefined;
    if (match === undefined) {
      out += piece.text;
      index += 1;
    } else {
      const original = pieces
        .slice(index, index + match.taken)
        .map(({ text: written }) => written)
        .join("");
      out += casedLike(match.to, original);
      index += match.taken;
    }
  }
  return out;
};

/**
 * Whether a fix's dictated words are words apart only by spaces: dictated
 * words with punctuation, as `C++`, would otherwise match their words alone.
 */
const wordsOnly = (phrase: string): boolean => {
  const pieces = splitWords(phrase);
  return (
    pieces.some(({ kind }) => kind === "word") &&
    pieces.every(({ kind, text }) => kind === "word" || /^ +$/u.test(text))
  );
};

/** The first fix, longest first, whose words start at `start`, and how many pieces they cover. */
const fixAt = (
  pieces: Pieces,
  start: number,
  active: readonly { keys: readonly string[]; to: string }[],
): { to: string; taken: number } | undefined => {
  for (const { keys, to } of active) {
    const leading = leadingWords(pieces, start, keys.length);
    if (leading?.words.every((word, at) => wordKey(word) === keys[at])) {
      return { to, taken: leading.taken };
    }
  }
  return undefined;
};

/** Whether a fix changes only case, as "Mckenzie" to "McKenzie". */
const caseOnly = (fix: { from: string; to: string }): boolean =>
  phraseKey(fix.from) === phraseKey(fix.to);

/**
 * Whether a correction turns a fix's words back: compared in any case,
 * or as written for a fix that changes only case.
 */
const turnsBack = (
  fix: LearnedFix,
  correction: { from: string; to: string },
): boolean => {
  const same = caseOnly(fix)
    ? (left: string, right: string) => exactPhrase(left) === exactPhrase(right)
    : (left: string, right: string) => phraseKey(left) === phraseKey(right);
  return same(fix.from, correction.to) && same(fix.to, correction.from);
};

/** Whether a run of words kept as dictated holds a fix's dictated words. */
const keptAsDictated = (run: readonly string[], fix: LearnedFix): boolean => {
  if (caseOnly(fix)) {
    return containsRun(run, exactPhrase(fix.from).split(" "));
  }
  return containsRun(run.map(wordKey), phraseKey(fix.from).split(" "));
};

const exactPhrase = (phrase: string): string =>
  wordsOf(phrase)
    .map(({ exact }) => exact)
    .join(" ");

const firstSighting = (from: string, to: string): LearnedFix => ({
  from,
  to,
  seen: 1,
  status: "learning",
});

const contradicted = (fix: LearnedFix): LearnedFix =>
  fix.status === "off" ? fix : { ...fix, status: "contradicted" };

/** A fix seen corrected again: the same way counts, another way contradicts it. */
const sighted = (fix: LearnedFix, to: string): LearnedFix => {
  if (fix.to !== to) {
    return contradicted(fix);
  }
  const seen = fix.seen + 1;
  return {
    ...fix,
    seen,
    status:
      fix.status === "learning" && seen >= SIGHTINGS_TO_APPLY
        ? "on"
        : fix.status,
  };
};

type Word = {
  readonly text: string;
  /** As written, curly apostrophes made straight. */
  readonly exact: string;
  readonly key: string;
  readonly start: number;
  readonly end: number;
};

const wordsOf = (text: string): Word[] => {
  const words: Word[] = [];
  let offset = 0;
  for (const piece of splitWords(text)) {
    if (piece.kind === "word") {
      words.push({
        text: piece.text,
        exact: piece.text.replaceAll("’", "'"),
        key: wordKey(piece.text),
        start: offset,
        end: offset + piece.text.length,
      });
    }
    offset += piece.text.length;
  }
  return words;
};

/** How two words compare: in lower case, with curly apostrophes made straight. */
const wordKey = (word: string): string =>
  word.toLowerCase().replaceAll("’", "'");

const phraseKey = (phrase: string): string =>
  wordsOf(phrase)
    .map(({ key }) => key)
    .join(" ");

/**
 * Words as they read in `text`, joined by single spaces. A capital that
 * only marks the start of a sentence is not part of the spelling.
 */
/** The first letter, as one code point, and the rest. */
const splitInitial = (text: string): [string, string] => {
  const head = Array.from(text).at(0) ?? "";
  return [head, text.slice(head.length)];
};

const asWritten = (words: readonly Word[], text: string): string => {
  const phrase = words.map(({ text: word }) => word).join(" ");
  const first = words.at(0);
  if (first === undefined || !startsSentence(text, first.start)) {
    return phrase;
  }
  const [head, rest] = splitInitial(phrase);
  return head !== head.toLowerCase() && rest === rest.toLowerCase()
    ? `${head.toLowerCase()}${rest}`
    : phrase;
};

/** Quotes, brackets and spaces between a sentence's end and its first word. */
const SKIPPED_BEFORE_WORD = /^["'“”„‘’«»([\s]$/u;

/** Whether the word at `offset` begins a sentence: at the start, after a line break or a sentence's end. */
const startsSentence = (text: string, offset: number): boolean => {
  let end = offset;
  while (end > 0 && SKIPPED_BEFORE_WORD.test(text.charAt(end - 1))) {
    end -= 1;
  }
  const before = text.slice(0, end);
  return (
    before === "" ||
    /[.!?…]$/u.test(before) ||
    /\n/u.test(text.slice(before.length, offset))
  );
};

/**
 * Whether `to` is a spelling fix of `from` rather than other words: close
 * letters, no digits, no part of a word added or dropped, and more than a
 * change of the first letter's case.
 */
const isCorrection = (from: string, to: string): boolean => {
  if (
    from === to ||
    from.length > LEARNED_FIX_TEXT_LIMIT ||
    to.length > LEARNED_FIX_TEXT_LIMIT ||
    /\p{N}/u.test(`${from}${to}`) ||
    (splitInitial(from)[1] === splitInitial(to)[1] &&
      splitInitial(from)[0].toLowerCase() === splitInitial(to)[0].toLowerCase())
  ) {
    return false;
  }
  const a = fold(from.replaceAll(/\s+/gu, ""));
  const b = fold(to.replaceAll(/\s+/gu, ""));
  const longest = Math.max(Array.from(a).length, Array.from(b).length);
  if (Math.min(Array.from(a).length, Array.from(b).length) < MIN_FIX_LETTERS) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (a.startsWith(b) || b.startsWith(a) || a.endsWith(b) || b.endsWith(a)) {
    return false;
  }
  return distance(a, b) <= Math.max(1, Math.floor(longest / 3));
};

/** Runs of dictated word keys outside every edit, when there was an edit. */
const keptRuns = (
  words: readonly Word[],
  hunks: readonly Hunk[],
  { first, end }: { first: number; end: number },
): string[][] => {
  const runs: string[][] = [];
  let run: string[] = [];
  for (let index = first; index < end; index += 1) {
    // Words put in before this one part it from the words before.
    if (hunks.some(({ old }) => old.start === index && old.end === index)) {
      runs.push(run);
      run = [];
    }
    const edited = hunks.some(
      ({ old }) => old.start <= index && index < old.end,
    );
    if (edited) {
      runs.push(run);
      run = [];
    } else {
      run.push(words[index]?.exact ?? "");
    }
  }
  runs.push(run);
  return runs.filter((kept) => kept.length > 0);
};

type Pieces = ReturnType<typeof splitWords>;

/**
 * The first `count` words of `pieces` from `start` on when only spaces
 * separate them, and how many pieces they span.
 */
const leadingWords = (
  pieces: Pieces,
  start: number,
  count: number,
): { words: string[]; taken: number } | undefined => {
  const words: string[] = [];
  for (let index = 0; start + index < pieces.length; index += 1) {
    const piece = pieces.at(start + index);
    if (piece === undefined) {
      return undefined;
    }
    if (piece.kind === "word") {
      words.push(piece.text);
    } else if (!/^ +$/u.test(piece.text)) {
      return undefined;
    }
    if (words.length === count) {
      return { words, taken: index + 1 };
    }
  }
  return undefined;
};

const containsRun = (
  words: readonly string[],
  run: readonly string[],
): boolean =>
  run.length > 0 &&
  words.some((_, start) =>
    run.every((word, offset) => words[start + offset] === word),
  );

type Range = { readonly start: number; readonly end: number };
/** A run of old words replaced by a run of new ones; either may be empty. */
type Hunk = { readonly old: Range; readonly next: Range };

/**
 * The changes from `old` to `next`, by the longest common subsequence of
 * whole words; undefined when the texts are too long to compare.
 */
const wordHunks = (
  old: readonly string[],
  next: readonly string[],
): Hunk[] | undefined => {
  let prefix = 0;
  while (
    prefix < old.length &&
    prefix < next.length &&
    old[prefix] === next[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const a = old.slice(prefix, old.length - suffix);
  const b = next.slice(prefix, next.length - suffix);
  if (a.length === 0 && b.length === 0) {
    return [];
  }
  const whole = {
    old: { start: prefix, end: prefix + a.length },
    next: { start: prefix, end: prefix + b.length },
  };
  if (a.length === 0 || b.length === 0) {
    return [whole];
  }
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return undefined;
  }
  // `common[i][j]`: the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const common = Array.from({ length: (a.length + 1) * width }, () => 0);
  const at = (i: number, j: number) => common[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: { i: number; j: number } | undefined;
  const close = () => {
    if (open !== undefined) {
      hunks.push({
        old: { start: prefix + open.i, end: prefix + i },
        next: { start: prefix + open.j, end: prefix + j },
      });
      open = undefined;
    }
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
    } else {
      open ??= { i, j };
      if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }
  close();
  return hunks;
};
