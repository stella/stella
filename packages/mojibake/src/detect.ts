/**
 * Text decoded with the wrong character set, found without reading what the
 * text says.
 *
 * Three kinds of evidence, the later ones weighed against the declared
 * language's alphabet:
 *
 * - U+FFFD (bytes a decoder could not read) and C1 control characters
 *   (bytes a single-byte decoder mapped to no printable character): wrong
 *   in any language, and found whatever language is declared;
 * - runs that are valid UTF-8 once written back as windows-1252 or Latin-1
 *   bytes. The restored letters must read natively in the declared
 *   language, and a restored mark whose lead is a letter the language
 *   writes ("Â¹" in French) counts only when a lowercase letter vouches for
 *   it. Where the language has no alphabet, the restored letters need only
 *   stay in one script and no mark counts on its own: "Â" may be a writer's
 *   letter, so "Â§" alone is not reported there, while "courtâ€™s" is;
 * - reversible mis-decoding, only where the language has an alphabet: for
 *   every pair of charsets (written in one, read as the other) the words
 *   that do not fit the alphabet are written back with the charset they
 *   were read as and read with the one they were written in. A pair that
 *   turns several distinct misfit words into the language's own letters,
 *   while leaving the words that already fit alone, is the pair the text
 *   went through.
 *
 * The alphabet is the language's CLDR exemplar set (`alphabet.ts`), so the
 * same code covers every language CLDR does, and no language needs a list
 * written for it.
 */

import { type Alphabet, alphabetFor } from "./alphabet.js";
import {
  type Charset,
  decodeBytes,
  DECODING_PAIRS,
  type DecodingPair,
  encodeText,
  isEncodable,
  undoMisdecoding,
} from "./charsets.js";

/** Evidence below these counts is what a legitimate foreign name produces. */
const MIN_FIXED_OCCURRENCES = 3;
const MIN_FIXED_WORDS = 2;
/**
 * Distinct words a pair must repair when every one of them is only spelled
 * in letters the language does not write. Letters alone are what foreign
 * names are made of too, so a text with no garbled word needs more of them:
 * a Czech sentence naming Søren from Brønshøj is not windows-1250 read as
 * windows-1252.
 *
 * The price is recall on short text: two distinct corrupted native words
 * look exactly like two foreign names, so a sentence whose only damage is
 * "øízení" and "naøízení" (Czech "řízení", "nařízení" through windows-1250
 * read as windows-1252) stays clean however often they repeat; a third word
 * reports it. `detect.test.ts` pins both sides of the threshold.
 */
const MIN_FOREIGN_WORDS = 3;
/**
 * Occurrences of evidence against a pair assumed before any is counted, so
 * that a handful of words agreeing never reads as certainty.
 */
const CONFIDENCE_PRIOR = 1;
/**
 * How many repaired occurrences a pair needs per word it would break. A text
 * that really went through the pair has almost no word it breaks: its
 * correctly-read words are the ones its charsets agree on.
 */
const FIXED_PER_DAMAGED = 4;
/** Two layers is double-encoded UTF-8; a third is not seen in practice. */
const MAX_LAYERS = 2;
const MIN_UTF8_SIGNATURE_OCCURRENCES = 2;
/**
 * Bounds on the work one check does, so that a long text of distinct words,
 * or one long word, cannot hold a synchronous caller for seconds. The most
 * frequent words are examined first; a check that stops at a bound says so
 * (`incomplete`) instead of calling the text clean. Splitting the text into
 * words and choosing the most frequent are not bounded, but linear: a
 * hand-written scan that reads each code unit at most three times
 * (`scanText`), whatever the text's shape, and two passes over the distinct
 * words for each choice (`mostFrequent`).
 */
export const MAX_EXAMINED_WORDS = 20_000;
/**
 * Code units in the longest word weighed. A word is split on ASCII
 * whitespace only, so text without it (a payload, a space-free script, words
 * joined by U+00A0) is one word, and reading that back through every pair is
 * work no check can afford.
 */
export const MAX_WORD_CODE_UNITS = 256;
/** Misfit words every pair is tried on. */
export const MAX_PAIR_MISFITS = 200;
/** Words read back through a pair, across all pairs. */
export const PAIR_EVALUATION_BUDGET = 40_000;
/** Code units classified or read back through a charset, across the check. */
export const CODE_UNIT_BUDGET = 2_000_000;
const MAX_SAMPLES = 5;
const PREVIEW_CHARS = 400;

const REPLACEMENT_CHARACTER = 0xff_fd;
const C1_FIRST = 0x80;
const C1_LAST = 0x9f;

const NON_ASCII = /[\u0080-\u{10FFFF}]/u;
const LETTER = /^[\p{L}\p{M}]$/u;
/**
 * Marks written against the edge of a word: a unit's exponent ("m²"), a
 * footnote reference ("poznámka³"), degrees ("20°C"). Beside a letter they
 * are notation, not a letter a decoder misread; between two letters they
 * are not ("by³o" is Polish "było" read as windows-1252).
 */
const NOTATION = /^[\u00B0\u00B2\u00B3\u00B9\u2070-\u209F]$/u;
const LOWERCASE = /^\p{Ll}$/u;
const UPPERCASE = /^\p{Lu}$/u;

export type TextSpan = { start: number; end: number; text: string };
export type RepairedSpan = TextSpan & { repaired: string };

export type MisdecodingLayers = 1 | 2;

export type EncodingFinding =
  | { kind: "replacement-character"; occurrences: number; samples: TextSpan[] }
  | { kind: "c1-control"; occurrences: number; samples: TextSpan[] }
  | {
      kind: "utf8-read-as-single-byte";
      occurrences: number;
      samples: RepairedSpan[];
    }
  | {
      kind: "misdecoded";
      pair: DecodingPair;
      /**
       * Other pairs that explain the text equally well but would repair some
       * word differently. Empty when the repair is unambiguous; otherwise
       * the text is mis-decoded for certain and its repair needs the source.
       */
      alternatives: DecodingPair[];
      layers: MisdecodingLayers;
      /**
       * Share of the evidence that agrees with the pair, below 1: one
       * disagreeing occurrence is assumed before any is counted.
       */
      confidence: number;
      fixedOccurrences: number;
      damagedOccurrences: number;
      samples: RepairedSpan[];
      /** The start of the text with the pair undone. */
      preview: string;
    };

export type EncodingFindingKind = EncodingFinding["kind"];

/**
 * Test-only: how much work a check actually did, so a test can assert the
 * documented bounds (`MAX_EXAMINED_WORDS`, `PAIR_EVALUATION_BUDGET`,
 * `CODE_UNIT_BUDGET`) without timing the check. The caller owns the object;
 * every check overwrites every field with its own work alone.
 */
export type EncodingCheckCounters = {
  /** Distinct words weighed, after the length and distinct-words bounds. */
  wordsExamined: number;
  /** Word read-backs spent trying every pair, across all pairs. */
  pairEvaluations: number;
  /** Code units classified or read back through a charset. */
  codeUnits: number;
  /**
   * Code units the split into words, its signature scan and its edge trims
   * read, and a unit per distinct word each time the most frequent are
   * chosen: linear in the text (at most four times its length) and outside
   * the budgets.
   */
  scannedCodeUnits: number;
};

export type CheckTextEncodingOptions = {
  counters?: EncodingCheckCounters;
};

/** The bound a check stopped at before it had weighed every word. */
export type EncodingCheckLimit =
  | "distinct-words"
  | "long-words"
  | "misfit-words"
  | "pair-evaluations"
  | "code-units";

export type EncodingCheck =
  | { status: "clean" }
  | {
      status: "suspect";
      findings: readonly [EncodingFinding, ...EncodingFinding[]];
    }
  /**
   * Nothing found, but the check reached `limit` before it had weighed
   * every word, so that is no verdict that the text is clean. Evidence found
   * within the bound is `suspect` as usual.
   */
  | { status: "incomplete"; limit: EncodingCheckLimit };

type WordStat = { count: number; start: number };

type WordClass =
  /** Reads as the language: every letter native, at least one non-ASCII. */
  | "native"
  /**
   * No letter a writer chose: a control, a symbol between letters or
   * against one, a capital inside a lowercase word, two scripts in one word.
   */
  | "garbled"
  /** Letters the language does not write, and nothing garbled. */
  | "foreign"
  /** The language's letters with notation against their edge ("m²"). */
  | "notation"
  /** Nothing either way: ASCII, digits, the language's own punctuation. */
  | "neutral";

/** Word classes a pair may be the explanation of. */
const isMisfit = (wordClass: WordClass): boolean =>
  wordClass === "garbled" ||
  wordClass === "foreign" ||
  wordClass === "notation";

const isLetter = (char: string): boolean => LETTER.test(char);

const isControlOrReplacement = (cp: number): boolean =>
  cp === REPLACEMENT_CHARACTER || (cp >= C1_FIRST && cp <= C1_LAST);

/**
 * Scripts a word's letters can be told apart by. A letter in none of them
 * counts as a script of its own.
 */
const SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Georgian}/u,
];

/**
 * Whether every letter of a word is in one script: a word does not change
 * script in its middle, and a decoder reading the wrong table often makes it
 * (Slovak "KÚŽP" in windows-1252 is the UTF-8 bytes of Arabic "ڎ").
 */
/** Script index per letter code point; the regexes run once per letter. */
const scriptCache = new Map<number, number>();

const scriptOf = (char: string): number => {
  const cp = char.codePointAt(0) ?? 0;
  const cached = scriptCache.get(cp);
  if (cached !== undefined) {
    return cached;
  }
  const script = SCRIPTS.findIndex((pattern) => pattern.test(char));
  scriptCache.set(cp, script);
  return script;
};

const writtenInOneScript = (word: string): boolean => {
  let first: number | undefined;
  for (const char of word) {
    if ((char.codePointAt(0) ?? 0) < C1_FIRST) {
      // ASCII letters are Latin.
      if (!isLetter(char)) {
        continue;
      }
    } else if (!isLetter(char) || /\p{M}/u.test(char)) {
      continue;
    }
    const script = scriptOf(char);
    if (first === undefined) {
      first = script;
    } else if (script !== first) {
      return false;
    }
  }
  return true;
};

const classifyWord = (word: string, alphabet: Alphabet): WordClass => {
  const chars = Array.from(word.normalize("NFC"));
  let nativeLetter = false;
  let foreignLetter = false;
  let notation = false;
  for (const [index, char] of chars.entries()) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < C1_FIRST) {
      continue;
    }
    if (isControlOrReplacement(cp)) {
      return "garbled";
    }
    const before = chars[index - 1];
    if (isLetter(char)) {
      // A capital inside a lowercase word ("dignitÊ") is a letter read from
      // the wrong byte, not one a writer chose.
      if (
        UPPERCASE.test(char) &&
        before !== undefined &&
        LOWERCASE.test(before)
      ) {
        return "garbled";
      }
      if (alphabet.native.has(cp)) {
        nativeLetter = true;
      } else {
        foreignLetter = true;
      }
      continue;
    }
    if (alphabet.punctuation.has(cp)) {
      continue;
    }
    // A symbol standing apart ("¾ podílu", "m ²") is a symbol; one welded
    // between letters ("pod¾a"), or against one when it is no notation
    // ("¾udia"), stands where a letter was.
    const after = chars[index + 1];
    const letterBefore = before !== undefined && isLetter(before);
    const letterAfter = after !== undefined && isLetter(after);
    if (letterBefore && letterAfter) {
      return "garbled";
    }
    if (letterBefore || letterAfter) {
      if (!NOTATION.test(char)) {
        return "garbled";
      }
      notation = true;
    }
  }
  // Letters of two scripts in one word: Bulgarian "Latvieрu" is Latvian
  // "Latviešu" read through windows-1251, and both alphabets allow each of
  // its letters.
  if (!writtenInOneScript(word)) {
    return "garbled";
  }
  if (foreignLetter) {
    return "foreign";
  }
  if (notation) {
    return "notation";
  }
  return nativeLetter ? "native" : "neutral";
};

type UndoneWord = { text: string; failed: boolean };

/**
 * Punctuation and signs whose UTF-8 bytes read as windows-1252 are "â€"
 * or "Â" followed by more punctuation ("â€™" for ’, "â€”" for —, "Â§" for
 * §). No pair of letters reads back into one (a letter byte after C2 or E2
 * spells a control, a letter or a mathematical sign); only the lead byte
 * reads as a letter (`marksSignOnTheirOwn`).
 */
const RESTORED_PUNCTUATION = /^[\u00A0-\u00BF\u2000-\u206F\u20AC\u2122]$/u;

const isRestoredPunctuation = (char: string): boolean =>
  !isLetter(char) && RESTORED_PUNCTUATION.test(char);

/**
 * One word with the pair undone. A character the assumed charset cannot
 * encode was not produced by reading it; it splits the word and stays as it
 * is, so a quotation mark added after the text was mis-read does not block
 * the repair of the letters around it. `failed` reports a non-ASCII run that
 * is not valid in the actual charset, or a letter the assumed charset has no
 * byte for: text read through the pair cannot contain it, so a word that
 * does is evidence against the pair (Slovak "že" rules out anything read as
 * Latin-1).
 */
const undoWord = (word: string, pair: DecodingPair): UndoneWord => {
  let text = "";
  let run = "";
  let failed = false;
  const flush = () => {
    if (run.length === 0) {
      return;
    }
    const undone = undoMisdecoding(run, pair);
    if (undone === null) {
      failed ||= NON_ASCII.test(run);
      text += run;
    } else {
      text += undone;
    }
    run = "";
  };
  for (const char of word) {
    if (isEncodable(char.codePointAt(0) ?? 0, pair.assumed)) {
      run += char;
    } else {
      flush();
      failed ||= isLetter(char);
      text += char;
    }
  }
  flush();
  return { text, failed };
};

type WordRepair =
  | { status: "repaired"; text: string; layers: MisdecodingLayers }
  | { status: "unrepaired" };

type RepairWordOptions = {
  pair: DecodingPair;
  alphabet: Alphabet;
  maxLayers: MisdecodingLayers;
  /** Where a bounded check counts the code units read back and classified. */
  work?: EncodingCheckCounters;
};

/** A word through up to `maxLayers` layers of the pair, until it reads natively. */
const repairWord = (
  word: string,
  { pair, alphabet, maxLayers, work }: RepairWordOptions,
): WordRepair => {
  let current = word;
  for (let layer = 1; layer <= maxLayers; layer += 1) {
    const undone = undoWord(current, pair);
    if (work !== undefined) {
      work.codeUnits += current.length;
    }
    if (undone.failed || undone.text === current) {
      return { status: "unrepaired" };
    }
    if (work !== undefined) {
      work.codeUnits += undone.text.length;
    }
    if (classifyWord(undone.text, alphabet) === "native") {
      return {
        status: "repaired",
        text: undone.text,
        layers: layer === 1 ? 1 : 2,
      };
    }
    current = undone.text;
  }
  return { status: "unrepaired" };
};

/**
 * Words are split on ASCII whitespace only: U+00A0 is the second byte of
 * UTF-8 "à" read as windows-1252, so treating it as a separator would cut
 * the evidence in half.
 */
const isSeparator = (cp: number): boolean =>
  cp === 0x20 || (cp >= 0x09 && cp <= 0x0d);

const isAsciiLetter = (cp: number): boolean =>
  (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);

const isAsciiNonLetter = (cp: number): boolean =>
  cp < C1_FIRST && !isAsciiLetter(cp);

type WordVisitor = (start: number, end: number) => void;

/**
 * Calls `visit` with the bounds of every word, reading each code unit once.
 * A scan rather than a regular expression, so that no input shape can make
 * it read a code unit again.
 */
const forEachWord = (text: string, visit: WordVisitor): void => {
  let index = 0;
  while (index < text.length) {
    while (index < text.length && isSeparator(text.codePointAt(index) ?? 0)) {
      index += 1;
    }
    const start = index;
    while (index < text.length && !isSeparator(text.codePointAt(index) ?? 0)) {
      index += 1;
    }
    if (index > start) {
      visit(start, index);
    }
  }
};

type Signature = { occurrences: number; samples: TextSpan[] };

type ScannedText = {
  replacement: Signature;
  c1: Signature;
  /** Distinct words with a non-ASCII character, each with its count and first offset. */
  words: Map<string, WordStat>;
};

type SignatureOccurrence = {
  text: string;
  start: number;
  end: number;
  occurrences: number;
};

const addSignature = (
  signature: Signature,
  { text, start, end, occurrences }: SignatureOccurrence,
): void => {
  if (occurrences === 0) {
    return;
  }
  signature.occurrences += occurrences;
  if (signature.samples.length < MAX_SAMPLES) {
    signature.samples.push({ start, end, text: text.slice(start, end) });
  }
};

/**
 * The text's signatures and its distinct words, in one pass over its words.
 * ASCII that is not a letter is trimmed from both edges of a word first
 * ("Søren," is "Søren"): every pair reads ASCII as itself, so the trim
 * changes no word's evidence, only how often it is counted. Each trim scans
 * in from its own edge and stops where the other did, so a code unit is
 * read at most three times: by the split, the signature scan and a trim.
 */
const scanText = (text: string, work: EncodingCheckCounters): ScannedText => {
  const scanned: ScannedText = {
    replacement: { occurrences: 0, samples: [] },
    c1: { occurrences: 0, samples: [] },
    words: new Map(),
  };
  work.scannedCodeUnits += text.length;
  forEachWord(text, (start, end) => {
    let replacements = 0;
    let controls = 0;
    let nonAscii = false;
    for (let index = start; index < end; index += 1) {
      const cp = text.codePointAt(index) ?? 0;
      if (cp === REPLACEMENT_CHARACTER) {
        replacements += 1;
      } else if (cp >= C1_FIRST && cp <= C1_LAST) {
        controls += 1;
      }
      nonAscii ||= cp >= C1_FIRST;
    }
    work.scannedCodeUnits += end - start;
    addSignature(scanned.replacement, {
      text,
      start,
      end,
      occurrences: replacements,
    });
    addSignature(scanned.c1, { text, start, end, occurrences: controls });
    if (!nonAscii) {
      return;
    }
    let first = start;
    while (first < end && isAsciiNonLetter(text.codePointAt(first) ?? 0)) {
      first += 1;
    }
    let last = end;
    while (last > first && isAsciiNonLetter(text.codePointAt(last - 1) ?? 0)) {
      last -= 1;
    }
    work.scannedCodeUnits += first - start + (end - last);
    const word = text.slice(first, last);
    const stat = scanned.words.get(word);
    if (stat === undefined) {
      scanned.words.set(word, { count: 1, start: first });
    } else {
      stat.count += 1;
    }
  });
  return scanned;
};

/**
 * The `limit` most frequent words, the earliest first among equally frequent
 * ones, in the order the text first uses them (the order `words` is in):
 * the words a bounded check weighs, and the order its samples are read in.
 * Chosen in two passes over the words, not by sorting them: one counts the
 * words at each count, which gives the lowest count that makes the cut, and
 * one keeps the words above it and the earliest at it. Each pass reads a
 * word once and counts it as one scanned code unit (it holds at least one).
 */
type MostFrequentOptions = {
  limit: number;
  work: EncodingCheckCounters;
};

const mostFrequent = <T extends { stat: WordStat }>(
  words: readonly T[],
  { limit, work }: MostFrequentOptions,
): readonly T[] => {
  if (words.length <= limit) {
    return words;
  }
  const wordsPerCount = new Map<number, number>();
  for (const { stat } of words) {
    wordsPerCount.set(stat.count, (wordsPerCount.get(stat.count) ?? 0) + 1);
  }
  // Counts add up to at most the text's length, so n occurrences have fewer
  // than √(2n) distinct counts: sorting them is not sorting the words.
  let cutoff = 0;
  let keptAtCutoff = 0;
  let kept = 0;
  for (const [count, number] of Array.from(wordsPerCount).toSorted(
    ([a], [b]) => b - a,
  )) {
    if (kept + number >= limit) {
      cutoff = count;
      keptAtCutoff = limit - kept;
      break;
    }
    kept += number;
  }
  const selected: T[] = [];
  for (const word of words) {
    if (word.stat.count > cutoff) {
      selected.push(word);
    } else if (word.stat.count === cutoff && keptAtCutoff > 0) {
      selected.push(word);
      keptAtCutoff -= 1;
    }
  }
  work.scannedCodeUnits += 2 * words.length;
  return selected;
};

/**
 * A word by its letters alone: what makes two misfit words two words of
 * evidence rather than one word punctuated twice („Søren“ and Søren).
 */
const lexeme = (word: string): string => {
  const letters = Array.from(word).filter(isLetter).join("");
  return letters.length === 0 ? word : letters;
};

const span = (word: string, stat: WordStat): TextSpan => ({
  start: stat.start,
  end: stat.start + word.length,
  text: word,
});

type PairEvidence = {
  pair: DecodingPair;
  layers: MisdecodingLayers;
  fixedOccurrences: number;
  damagedOccurrences: number;
  /** Native-looking words the pair turns into other native words. */
  convertedOccurrences: number;
  unresolvedOccurrences: number;
  samples: RepairedSpan[];
  /** Every word the pair changes, and what it changes it to. */
  repairs: ReadonlyMap<string, string>;
};

type CountedWord = { word: string; stat: WordStat };
type ClassifiedWord = CountedWord & { wordClass: WordClass };

/** A check's work so far, and the first bound it stopped at. */
type Progress = {
  work: EncodingCheckCounters;
  limit: EncodingCheckLimit | undefined;
};

type Cost = {
  /** Pair evaluations: words read back through a pair of `DECODING_PAIRS`. */
  words: number;
  /** Code units of the words, each read back or classified `passes` times. */
  codeUnits: number;
  passes: number;
};

/**
 * Whether the check can still afford `cost`; records the bound it cannot.
 * A read-back never lengthens a word (no pair assumes UTF-8), so the cost is
 * an upper bound on the work the counters then record.
 */
const affords = (
  progress: Progress,
  { words, codeUnits, passes }: Cost,
): boolean => {
  const { work } = progress;
  if (work.pairEvaluations + words > PAIR_EVALUATION_BUDGET) {
    progress.limit ??= "pair-evaluations";
    return false;
  }
  if (work.codeUnits + codeUnits * passes > CODE_UNIT_BUDGET) {
    progress.limit ??= "code-units";
    return false;
  }
  return true;
};

const codeUnitsOf = (words: readonly CountedWord[]): number =>
  words.reduce((total, { word }) => total + word.length, 0);

type PairEvidenceOptions = {
  misfits: readonly ClassifiedWord[];
  natives: readonly ClassifiedWord[];
  alphabet: Alphabet;
  progress: Progress;
};

/**
 * What the words say about one pair, null when the pair explains too few
 * of them, or "exhausted" when the budget ran out before it was weighed.
 */
const pairEvidence = (
  pair: DecodingPair,
  { misfits, natives, alphabet, progress }: PairEvidenceOptions,
): PairEvidence | null | "exhausted" => {
  const { work } = progress;
  const misfitCost = {
    words: misfits.length,
    codeUnits: codeUnitsOf(misfits),
    // A read-back and a classification per layer.
    passes: 2 * MAX_LAYERS,
  };
  if (!affords(progress, misfitCost)) {
    return "exhausted";
  }
  work.pairEvaluations += misfits.length;
  let fixedOccurrences = 0;
  /** Fixed occurrences of words that are more than attached notation. */
  let lexicalOccurrences = 0;
  const lexemes = new Set<string>();
  let garbled = false;
  let unresolvedOccurrences = 0;
  let doubleLayered = 0;
  const samples: RepairedSpan[] = [];
  const repairs = new Map<string, string>();
  for (const { word, stat, wordClass } of misfits) {
    const repair = repairWord(word, {
      pair,
      alphabet,
      maxLayers: MAX_LAYERS,
      work,
    });
    if (repair.status === "unrepaired") {
      unresolvedOccurrences += stat.count;
      continue;
    }
    fixedOccurrences += stat.count;
    // "m²" read back as "mž" is a repair only once other words show the
    // pair: an exponent is what a writer puts there.
    if (wordClass !== "notation") {
      lexicalOccurrences += stat.count;
      lexemes.add(lexeme(word));
      garbled ||= wordClass === "garbled";
    }
    repairs.set(word, repair.text);
    if (repair.layers === 2) {
      doubleLayered += stat.count;
    }
    if (samples.length < MAX_SAMPLES) {
      samples.push({ ...span(word, stat), repaired: repair.text });
    }
  }
  if (
    lexicalOccurrences < MIN_FIXED_OCCURRENCES ||
    lexemes.size < (garbled ? MIN_FIXED_WORDS : MIN_FOREIGN_WORDS)
  ) {
    return null;
  }
  // Only now the words that already read natively: a pair the text really
  // went through leaves them as they are, or turns them into other native
  // words (Polish "siź" is "się" through windows-1250 read as windows-1257),
  // and never breaks them.
  const nativeCost = {
    words: natives.length,
    codeUnits: codeUnitsOf(natives),
    passes: 2,
  };
  if (!affords(progress, nativeCost)) {
    return "exhausted";
  }
  work.pairEvaluations += natives.length;
  let damagedOccurrences = 0;
  let convertedOccurrences = 0;
  for (const { word, stat } of natives) {
    const undone = undoWord(word, pair);
    work.codeUnits += word.length;
    if (undone.text === word && !undone.failed) {
      continue;
    }
    if (!undone.failed) {
      work.codeUnits += undone.text.length;
    }
    if (undone.failed || classifyWord(undone.text, alphabet) !== "native") {
      damagedOccurrences += stat.count;
    } else {
      convertedOccurrences += stat.count;
      repairs.set(word, undone.text);
    }
  }
  return {
    pair,
    layers: doubleLayered * 2 > fixedOccurrences ? 2 : 1,
    fixedOccurrences,
    damagedOccurrences,
    convertedOccurrences,
    unresolvedOccurrences,
    samples,
    repairs,
  };
};

const score = (evidence: PairEvidence): readonly [number, number] => [
  evidence.fixedOccurrences - evidence.damagedOccurrences,
  evidence.convertedOccurrences,
];

type BestPair = {
  evidence: PairEvidence;
  /**
   * Pairs the evidence explains equally well that would write some word
   * differently. Exemplar letters cannot choose between them: windows-1250
   * and ISO-8859-2 both read "¾" back as a Slovak letter, "ľ" and "ž".
   */
  alternatives: DecodingPair[];
};

const repairsDiffer = (
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean => {
  for (const [word, repaired] of left) {
    const other = right.get(word);
    if (other !== undefined && other !== repaired) {
      return true;
    }
  }
  return false;
};

/**
 * The pair that best explains the misfit words, or null when none does.
 * Pairs that repair the misfit words alike are told apart by the
 * native-looking words they also turn into other native words; pairs still
 * tied that would repair some word differently are reported as
 * alternatives, and the first in `DECODING_PAIRS` order is proposed.
 */
const bestPair = (
  options: PairEvidenceOptions,
): BestPair | null | "exhausted" => {
  const accepted: PairEvidence[] = [];
  for (const pair of DECODING_PAIRS) {
    const evidence = pairEvidence(pair, options);
    if (evidence === "exhausted") {
      return evidence;
    }
    if (
      evidence !== null &&
      evidence.fixedOccurrences >=
        FIXED_PER_DAMAGED * evidence.damagedOccurrences
    ) {
      accepted.push(evidence);
    }
  }
  let best: PairEvidence | undefined;
  for (const evidence of accepted) {
    if (best === undefined) {
      best = evidence;
      continue;
    }
    const [primary, secondary] = score(evidence);
    const [bestPrimary, bestSecondary] = score(best);
    if (
      primary > bestPrimary ||
      (primary === bestPrimary && secondary > bestSecondary)
    ) {
      best = evidence;
    }
  }
  if (best === undefined) {
    return null;
  }
  const [bestPrimary] = score(best);
  const chosen = best;
  const alternatives = accepted
    .filter(
      (evidence) =>
        evidence !== chosen &&
        score(evidence)[0] === bestPrimary &&
        repairsDiffer(chosen.repairs, evidence.repairs),
    )
    .map(({ pair }) => pair);
  return { evidence: chosen, alternatives };
};

/** A word with letters, none of them lowercase. */
const CAPITALS_ONLY = /^(?=.*\p{L})\P{Ll}*$/u;

/**
 * Spaces that bind two words into one token: the split keeps them inside a
 * word, since U+00A0 is also the second byte of UTF-8 "à" read as
 * windows-1252.
 */
const isNonbreakingSpace = (char: string): boolean =>
  char === "\u00A0" || char === "\u2007" || char === "\u202F";

const UTF8_SIGNATURE_PAIRS: readonly DecodingPair[] = (
  ["windows-1252", "iso-8859-1"] satisfies Charset[]
).map((assumed) => ({ actual: "utf-8", assumed }));

/** What `assumed` reads each of `bytes` as, as a regex character class body. */
const readAs = (bytes: readonly number[]): string =>
  UTF8_SIGNATURE_PAIRS.flatMap(({ assumed }) =>
    bytes.map((byte) => decodeBytes(Uint8Array.of(byte), assumed)),
  )
    .filter((char): char is string => char !== null)
    .map((char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`)
    .join("");

const byteRange = (first: number, last: number): number[] =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

/**
 * A UTF-8 lead byte followed by a continuation byte, as either charset
 * reads them: a word without one cannot read back as UTF-8, and is not
 * written back to find out.
 */
const UTF8_SEQUENCE_READ_AS_SINGLE_BYTE = new RegExp(
  `[${readAs(byteRange(0xc2, 0xf4))}][${readAs(byteRange(0x80, 0xbf))}]`,
  "u",
);

/**
 * Whether a word read back as UTF-8 reads as something a person wrote:
 * its restored marks are punctuation, and its restored letters, if any,
 * read natively in the language (or, where it is not known, stay in one
 * script).
 */
type ReadsAsWrittenOptions = {
  word: string;
  alphabet: Alphabet | null;
  work: EncodingCheckCounters;
};

const readsAsWritten = (
  undone: UndoneWord,
  { word, alphabet, work }: ReadsAsWrittenOptions,
): boolean => {
  if (undone.failed || undone.text === word) {
    return false;
  }
  const chars = Array.from(undone.text);
  if (chars.some((char) => isControlOrReplacement(char.codePointAt(0) ?? 0))) {
    return false;
  }
  const letters = chars.filter((char) => !isRestoredPunctuation(char)).join("");
  if (!NON_ASCII.test(letters)) {
    // Punctuation alone, around ASCII ("court’s", "—").
    return letters.length < chars.length;
  }
  if (
    !Array.from(letters).some((char) => NON_ASCII.test(char) && isLetter(char))
  ) {
    return false;
  }
  work.codeUnits += letters.length;
  return alphabet === null
    ? writtenInOneScript(letters)
    : classifyWord(letters, alphabet) === "native";
};

type ReadBackOptions = {
  alphabet: Alphabet | null;
  work: EncodingCheckCounters;
};

/** The first UTF-8 signature pair a word reads back through as written. */
const readBack = (
  word: string,
  { alphabet, work }: ReadBackOptions,
): { pair: DecodingPair; text: string } | undefined => {
  for (const pair of UTF8_SIGNATURE_PAIRS) {
    work.codeUnits += word.length;
    const undone = undoWord(word, pair);
    if (readsAsWritten(undone, { word, alphabet, work })) {
      return { pair, text: undone.text };
    }
  }
  return undefined;
};

/** Bytes in the UTF-8 sequence `lead` starts; zero for a byte that starts none. */
const utf8SequenceLength = (lead: number): number => {
  if (lead >= 0xc2 && lead <= 0xdf) {
    return 2;
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return 3;
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    return 4;
  }
  return 0;
};

type MarksSignOptions = {
  pair: DecodingPair;
  alphabet: Alphabet | null;
  work: EncodingCheckCounters;
};

/**
 * Whether a word read back through `pair` restores a mark from a sequence
 * whose lead is no letter the language writes, so that the mark is a
 * signature on its own.
 *
 * The bytes cannot tell the two apart where the lead is one: C2 B9 is "¹"
 * in UTF-8 and "Â¹" in windows-1252, and French and Romanian write "Â"
 * before a footnote mark, a nonbreaking space or a closing guillemet. That
 * a sequence reads back is no proof it was UTF-8, so there the mark needs a
 * word outside capitals to vouch for it, as a restored letter does. Czech
 * and English never write "Â", so there "Â§" and "20Â°C" are § and °C read
 * as windows-1252. Where the language is not known nothing tells a lead
 * byte from a writer's letter, so no mark signs on its own.
 */
const marksSignOnTheirOwn = (
  word: string,
  { pair, alphabet, work }: MarksSignOptions,
): boolean => {
  if (alphabet === null) {
    return false;
  }
  work.codeUnits += word.length;
  const chars = Array.from(word);
  let index = 0;
  while (index < chars.length) {
    const lead = chars[index] ?? "";
    const length = utf8SequenceLength(
      encodeText(lead, pair.assumed)?.at(0) ?? 0,
    );
    const restored =
      length === 0
        ? null
        : undoMisdecoding(chars.slice(index, index + length).join(""), pair);
    if (restored === null) {
      index += 1;
      continue;
    }
    if (
      isRestoredPunctuation(restored) &&
      !alphabet.native.has(lead.codePointAt(0) ?? 0)
    ) {
      return true;
    }
    index += length;
  }
  return false;
};

const vouches = (part: string): boolean =>
  !CAPITALS_ONLY.test(part) && UTF8_SEQUENCE_READ_AS_SINGLE_BYTE.test(part);

type VouchedByLowercaseOptions = {
  pair: DecodingPair;
  alphabet: Alphabet | null;
};

/**
 * Whether lowercase letters vouch for a word's read-back: some part of it
 * between nonbreaking spaces holds both a lowercase letter and a UTF-8
 * sequence. A nonbreaking space that completes a restored letter after a
 * lead the language does not write is inside its word (French or Italian
 * "Ã\u00A0" is "à"); any other one ends the part it closes, and the
 * lowercase word after it is another word. The bytes cannot tell the two
 * apart where the lead is a letter the language writes: Portuguese
 * "Ã\u00A0quela" is "àquela" read as windows-1252, and "Ã\u00A0representa"
 * is the capital Ã bound to the word after it. So is French "Â\u00A0est",
 * whose "Â\u00A0" restores a space.
 */
const vouchedByLowercase = (
  word: string,
  { pair, alphabet }: VouchedByLowercaseOptions,
): boolean => {
  let part = "";
  let lead = "";
  for (const char of word) {
    part += char;
    const previous = lead;
    lead = char;
    if (!isNonbreakingSpace(char)) {
      continue;
    }
    if (
      alphabet !== null &&
      !alphabet.native.has(previous.codePointAt(0) ?? 0)
    ) {
      const restored = undoMisdecoding(previous + char, pair);
      if (restored !== null && restored.length === 1 && isLetter(restored)) {
        continue;
      }
    }
    if (vouches(part)) {
      return true;
    }
    part = "";
  }
  return vouches(part);
};

type Utf8SignatureOptions = {
  alphabet: Alphabet | null;
  progress: Progress;
};

/**
 * Words that become valid UTF-8 with a non-ASCII letter or a punctuation
 * mark once written back as windows-1252 or Latin-1 bytes. A word a person
 * wrote rarely spells a UTF-8 multi-byte sequence in those bytes, but
 * capitals do: Czech "POSPÍŠIL" is bytes CD 8A, a combining mark, and Slovak
 * "VÝŠKA" is DD 8A, a Syriac one. So where the language is known the word
 * read back must read natively in it; where it is not, it must at least
 * stay in one script.
 */
const utf8Signature = (
  words: readonly CountedWord[],
  { alphabet, progress }: Utf8SignatureOptions,
): Extract<EncodingFinding, { kind: "utf8-read-as-single-byte" }> | null => {
  const { work } = progress;
  let occurrences = 0;
  let signed = false;
  const samples: RepairedSpan[] = [];
  for (const { word, stat } of words) {
    if (!UTF8_SEQUENCE_READ_AS_SINGLE_BYTE.test(word)) {
      continue;
    }
    // Read back and classified per pair, then scanned for lowercase and for
    // its marks once each; these pairs are not the ones pair evaluations
    // count.
    const cost = {
      words: 0,
      codeUnits: word.length,
      passes: 2 * UTF8_SIGNATURE_PAIRS.length + 2,
    };
    if (!affords(progress, cost)) {
      break;
    }
    const repaired = readBack(word, { alphabet, work });
    if (repaired === undefined) {
      continue;
    }
    occurrences += stat.count;
    // Capitals are where a writer's letters spell UTF-8 by accident (Slovak
    // "ÄŽ" is C4 8E, "Ď"): what capitals alone restore is no signature,
    // unless it is a mark no letter of the language leads.
    work.codeUnits += word.length;
    signed ||=
      vouchedByLowercase(word, { pair: repaired.pair, alphabet }) ||
      marksSignOnTheirOwn(word, { pair: repaired.pair, alphabet, work });
    if (samples.length < MAX_SAMPLES) {
      samples.push({ ...span(word, stat), repaired: repaired.text });
    }
  }
  return signed && occurrences >= MIN_UTF8_SIGNATURE_OCCURRENCES
    ? { kind: "utf8-read-as-single-byte", occurrences, samples }
    : null;
};

export type RepairMisdecodingOptions = {
  language: string;
  pair: DecodingPair;
  layers: MisdecodingLayers;
};

/**
 * The text with a pair undone, word by word, as the inverse of reading the
 * whole text through the pair: every word that reads natively once undone
 * (through at most `layers` layers) is replaced, including a native-looking
 * one the pair produced ("Äľudia" is "ľudia" through UTF-8 read as
 * windows-1250). A word the pair cannot have produced, or that would not
 * read natively, is left exactly as it is, and so is a word longer than
 * `MAX_WORD_CODE_UNITS`: no check weighs one, so no finding covers it, and
 * normalizing a long run of combining marks costs time quadratic in it. A
 * byte the wrong decoder dropped cannot come back, so the repair is only as
 * complete as what survived.
 */
export const repairMisdecoding = (
  text: string,
  { language, pair, layers }: RepairMisdecodingOptions,
): string => {
  const alphabet = alphabetFor(language);
  if (alphabet === null) {
    return text;
  }
  const repaired = new Map<string, string>();
  const pieces: string[] = [];
  let copied = 0;
  forEachWord(text, (start, end) => {
    if (end - start > MAX_WORD_CODE_UNITS) {
      return;
    }
    const word = text.slice(start, end);
    if (!NON_ASCII.test(word)) {
      return;
    }
    let next = repaired.get(word);
    if (next === undefined) {
      const repair =
        classifyWord(word, alphabet) === "neutral"
          ? ({ status: "unrepaired" } as const)
          : repairWord(word, { pair, alphabet, maxLayers: layers });
      next = repair.status === "repaired" ? repair.text : word;
      repaired.set(word, next);
    }
    if (next !== word) {
      pieces.push(text.slice(copied, start), next);
      copied = end;
    }
  });
  pieces.push(text.slice(copied));
  return pieces.join("");
};

/**
 * Checks `text` against the language it is declared to be in (a BCP-47
 * tag). A language CLDR has no exemplars for is checked for the
 * signatures only.
 */
export const checkTextEncoding = (
  text: string,
  language: string,
  { counters }: CheckTextEncodingOptions = {},
): EncodingCheck => {
  const findings: EncodingFinding[] = [];
  const progress: Progress = {
    work: {
      wordsExamined: 0,
      pairEvaluations: 0,
      codeUnits: 0,
      scannedCodeUnits: 0,
    },
    limit: undefined,
  };
  const scanned = scanText(text, progress.work);
  if (scanned.replacement.occurrences > 0) {
    findings.push({ kind: "replacement-character", ...scanned.replacement });
  }
  if (scanned.c1.occurrences > 0) {
    findings.push({ kind: "c1-control", ...scanned.c1 });
  }

  const words = Array.from(scanned.words, ([word, stat]) => ({
    word,
    stat,
  }));
  const weighable = words.filter(
    ({ word }) => word.length <= MAX_WORD_CODE_UNITS,
  );
  if (weighable.length < words.length) {
    progress.limit = "long-words";
  }
  if (weighable.length > MAX_EXAMINED_WORDS) {
    progress.limit ??= "distinct-words";
  }
  const examined = mostFrequent(weighable, {
    limit: MAX_EXAMINED_WORDS,
    work: progress.work,
  });
  progress.work.wordsExamined = examined.length;
  const alphabet = alphabetFor(language);
  const utf8 = utf8Signature(examined, { alphabet, progress });
  if (utf8 !== null) {
    findings.push(utf8);
  }

  if (alphabet !== null) {
    const classified: ClassifiedWord[] = [];
    for (const { word, stat } of examined) {
      if (!affords(progress, { words: 0, codeUnits: word.length, passes: 1 })) {
        break;
      }
      progress.work.codeUnits += word.length;
      classified.push({ word, stat, wordClass: classifyWord(word, alphabet) });
    }
    const allMisfits = classified.filter(({ wordClass }) =>
      isMisfit(wordClass),
    );
    if (allMisfits.length > MAX_PAIR_MISFITS) {
      progress.limit ??= "misfit-words";
    }
    const best =
      allMisfits.length === 0
        ? null
        : bestPair({
            misfits: mostFrequent(allMisfits, {
              limit: MAX_PAIR_MISFITS,
              work: progress.work,
            }),
            natives: classified.filter(
              ({ wordClass }) => wordClass === "native",
            ),
            alphabet,
            progress,
          });
    // An exhausted search has recorded the bound it stopped at.
    if (best !== null && best !== "exhausted") {
      const { evidence, alternatives } = best;
      const { pair, layers, fixedOccurrences, damagedOccurrences, samples } =
        evidence;
      findings.push({
        kind: "misdecoded",
        pair,
        alternatives,
        layers,
        confidence:
          fixedOccurrences /
          (fixedOccurrences +
            damagedOccurrences +
            evidence.unresolvedOccurrences +
            CONFIDENCE_PRIOR),
        fixedOccurrences,
        damagedOccurrences,
        samples,
        preview: repairMisdecoding(text.slice(0, PREVIEW_CHARS), {
          language,
          pair,
          layers,
        }),
      });
    }
  }

  if (counters !== undefined) {
    Object.assign(counters, progress.work);
  }
  const [first, ...rest] = findings;
  if (first !== undefined) {
    return { status: "suspect", findings: [first, ...rest] };
  }
  return progress.limit === undefined
    ? { status: "clean" }
    : { status: "incomplete", limit: progress.limit };
};
