/**
 * Text decoded with the wrong character set, found without reading the
 * language.
 *
 * Two kinds of evidence, both independent of what the text says:
 *
 * - signatures that are wrong in any language: U+FFFD (bytes a decoder could
 *   not read), C1 control characters (bytes a single-byte decoder mapped to
 *   no printable character), and runs that are valid UTF-8 once written back
 *   as windows-1252 or Latin-1 bytes;
 * - reversible mis-decoding: for every pair of charsets (written in one,
 *   read as the other) the words that do not fit the declared language's
 *   alphabet are written back with the charset they were read as and read
 *   with the one they were written in. A pair that turns several distinct
 *   misfit words into the language's own letters, while leaving the words
 *   that already fit alone, is the pair the text went through.
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
 * Bounds on the work one check does, so that a long text of distinct words
 * cannot hold a synchronous caller for seconds. The most frequent words are
 * examined first; a check that stops at a bound says so (`incomplete`)
 * instead of calling the text clean.
 */
const MAX_EXAMINED_WORDS = 20_000;
/** Misfit words every pair is tried on. */
const MAX_PAIR_MISFITS = 200;
/** Words read back through a pair, across all pairs. */
const PAIR_EVALUATION_BUDGET = 40_000;
const MAX_SAMPLES = 5;
const PREVIEW_CHARS = 400;

const REPLACEMENT_CHARACTER = 0xff_fd;
const C1_FIRST = 0x80;
const C1_LAST = 0x9f;

/**
 * Words are split on ASCII whitespace only: U+00A0 is the second byte of
 * UTF-8 "à" read as windows-1252, so treating it as a separator would cut
 * the evidence in half.
 */
const WORD = /[^\t\n\v\f\r ]+/gu;
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

/** The bound a check stopped at before it had weighed every word. */
export type EncodingCheckLimit =
  | "distinct-words"
  | "misfit-words"
  | "pair-evaluations";

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
};

/** A word through up to `maxLayers` layers of the pair, until it reads natively. */
const repairWord = (
  word: string,
  { pair, alphabet, maxLayers }: RepairWordOptions,
): WordRepair => {
  let current = word;
  for (let layer = 1; layer <= maxLayers; layer += 1) {
    const undone = undoWord(current, pair);
    if (undone.failed || undone.text === current) {
      return { status: "unrepaired" };
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

const LEADING_ASCII_NON_LETTERS = /^[\0-@[-`{-\x7f]*/u;
const TRAILING_ASCII_NON_LETTERS = /[\0-@[-`{-\x7f]*$/u;

/**
 * Distinct words, each with its count and first offset. ASCII that is not a
 * letter is trimmed from both edges first ("Søren," is "Søren"): every pair
 * reads ASCII as itself, so the trim changes no word's evidence, only how
 * often it is counted.
 */
const collectWords = (text: string): Map<string, WordStat> => {
  const words = new Map<string, WordStat>();
  for (const match of text.matchAll(WORD)) {
    const [token] = match;
    if (!NON_ASCII.test(token)) {
      continue;
    }
    const leading = LEADING_ASCII_NON_LETTERS.exec(token)?.[0].length ?? 0;
    const trailing = TRAILING_ASCII_NON_LETTERS.exec(token)?.[0].length ?? 0;
    const word = token.slice(leading, token.length - trailing);
    const stat = words.get(word);
    if (stat === undefined) {
      words.set(word, { count: 1, start: match.index + leading });
    } else {
      stat.count += 1;
    }
  }
  return words;
};

/**
 * The `limit` most frequent words, in the order the text first uses them:
 * the words a bounded check weighs, and the order its samples are read in.
 */
const mostFrequent = <T extends { stat: WordStat }>(
  words: readonly T[],
  limit: number,
): readonly T[] =>
  words.length <= limit
    ? words
    : words
        .toSorted(
          ({ stat: a }, { stat: b }) => b.count - a.count || a.start - b.start,
        )
        .slice(0, limit)
        .toSorted(({ stat: a }, { stat: b }) => a.start - b.start);

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

/** Word read-backs a check may still spend; spent in place. */
type Budget = { remaining: number };

type PairEvidenceOptions = {
  misfits: readonly ClassifiedWord[];
  natives: readonly ClassifiedWord[];
  alphabet: Alphabet;
  budget: Budget;
};

/**
 * What the words say about one pair, null when the pair explains too few
 * of them, or "exhausted" when the budget ran out before it was weighed.
 */
const pairEvidence = (
  pair: DecodingPair,
  { misfits, natives, alphabet, budget }: PairEvidenceOptions,
): PairEvidence | null | "exhausted" => {
  budget.remaining -= misfits.length;
  if (budget.remaining < 0) {
    return "exhausted";
  }
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
    const repair = repairWord(word, { pair, alphabet, maxLayers: MAX_LAYERS });
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
  budget.remaining -= natives.length;
  if (budget.remaining < 0) {
    return "exhausted";
  }
  let damagedOccurrences = 0;
  let convertedOccurrences = 0;
  for (const { word, stat } of natives) {
    const undone = undoWord(word, pair);
    if (undone.text === word && !undone.failed) {
      continue;
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

const signatureSpans = (
  text: string,
  test: (cp: number) => boolean,
): { occurrences: number; samples: TextSpan[] } => {
  let occurrences = 0;
  const samples: TextSpan[] = [];
  for (const match of text.matchAll(WORD)) {
    const [word] = match;
    let inWord = 0;
    for (const char of word) {
      if (test(char.codePointAt(0) ?? 0)) {
        inWord += 1;
      }
    }
    if (inWord === 0) {
      continue;
    }
    occurrences += inWord;
    if (samples.length < MAX_SAMPLES) {
      samples.push({
        start: match.index,
        end: match.index + word.length,
        text: word,
      });
    }
  }
  return { occurrences, samples };
};

/** A word with letters, none of them lowercase. */
const CAPITALS_ONLY = /^(?=.*\p{L})\P{Ll}*$/u;

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
 * Words that become valid UTF-8 with a non-ASCII letter or a punctuation
 * mark once written back as windows-1252 or Latin-1 bytes. A word a person wrote rarely spells a UTF-8
 * multi-byte sequence in those bytes, but capitals do: Czech "POSPÍŠIL" is
 * bytes CD 8A, a combining mark, and Slovak "VÝŠKA" is DD 8A, a Syriac one.
 * So where the language is known the word read back must read natively in
 * it; where it is not, it must at least stay in one script.
 */
/**
 * Punctuation and signs whose UTF-8 bytes read as windows-1252 are "â€"
 * or "Â" followed by more punctuation ("â€™" for ’, "â€”" for —, "Â§" for
 * §). No pair of letters reads back into one (a letter byte after C2 or E2
 * spells a control, a letter or a mathematical sign), so unlike a restored
 * letter a restored mark needs no alphabet to be told from a capital.
 */
const RESTORED_PUNCTUATION = /^[\u00A0-\u00BF\u2000-\u206F\u20AC\u2122]$/u;

const isRestoredPunctuation = (char: string): boolean =>
  !isLetter(char) && RESTORED_PUNCTUATION.test(char);

/**
 * Whether a word read back as UTF-8 reads as something a person wrote:
 * its restored marks are punctuation, and its restored letters, if any,
 * read natively in the language (or, where it is not known, stay in one
 * script).
 */
const readsAsWritten = (
  undone: UndoneWord,
  { word, alphabet }: { word: string; alphabet: Alphabet | null },
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
  return alphabet === null
    ? writtenInOneScript(letters)
    : classifyWord(letters, alphabet) === "native";
};

const utf8Signature = (
  words: readonly CountedWord[],
  alphabet: Alphabet | null,
): Extract<EncodingFinding, { kind: "utf8-read-as-single-byte" }> | null => {
  let occurrences = 0;
  let beyondCapitals = false;
  const samples: RepairedSpan[] = [];
  for (const { word, stat } of words) {
    if (!UTF8_SEQUENCE_READ_AS_SINGLE_BYTE.test(word)) {
      continue;
    }
    const repaired = UTF8_SIGNATURE_PAIRS.map((pair) =>
      undoWord(word, pair),
    ).find((undone) => readsAsWritten(undone, { word, alphabet }));
    if (repaired === undefined) {
      continue;
    }
    occurrences += stat.count;
    beyondCapitals ||= !CAPITALS_ONLY.test(word);
    if (samples.length < MAX_SAMPLES) {
      samples.push({ ...span(word, stat), repaired: repaired.text });
    }
  }
  // Capitals are where a writer's letters spell UTF-8 by accident (Slovak
  // "ÄŽ" is C4 8E, "Ď"): words in capitals alone are no signature.
  return beyondCapitals && occurrences >= MIN_UTF8_SIGNATURE_OCCURRENCES
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
 * read natively, is left exactly as it is. A byte the wrong decoder dropped
 * cannot come back, so the repair is only as complete as what survived.
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
  return text.replaceAll(WORD, (word) => {
    if (!NON_ASCII.test(word)) {
      return word;
    }
    const known = repaired.get(word);
    if (known !== undefined) {
      return known;
    }
    const repair =
      classifyWord(word, alphabet) === "neutral"
        ? ({ status: "unrepaired" } as const)
        : repairWord(word, { pair, alphabet, maxLayers: layers });
    const next = repair.status === "repaired" ? repair.text : word;
    repaired.set(word, next);
    return next;
  });
};

/**
 * Checks `text` against the language it is declared to be in (a BCP-47
 * tag). A language CLDR has no exemplars for is checked for the
 * signatures only.
 */
export const checkTextEncoding = (
  text: string,
  language: string,
): EncodingCheck => {
  const findings: EncodingFinding[] = [];

  const replacement = signatureSpans(
    text,
    (cp) => cp === REPLACEMENT_CHARACTER,
  );
  if (replacement.occurrences > 0) {
    findings.push({ kind: "replacement-character", ...replacement });
  }
  const c1 = signatureSpans(text, (cp) => cp >= C1_FIRST && cp <= C1_LAST);
  if (c1.occurrences > 0) {
    findings.push({ kind: "c1-control", ...c1 });
  }

  const words = collectWords(text);
  let limit: EncodingCheckLimit | undefined =
    words.size > MAX_EXAMINED_WORDS ? "distinct-words" : undefined;
  const examined = mostFrequent(
    Array.from(words, ([word, stat]) => ({ word, stat })),
    MAX_EXAMINED_WORDS,
  );
  const alphabet = alphabetFor(language);
  const utf8 = utf8Signature(examined, alphabet);
  if (utf8 !== null) {
    findings.push(utf8);
  }

  if (alphabet !== null) {
    const classified = examined.map(({ word, stat }) => ({
      word,
      stat,
      wordClass: classifyWord(word, alphabet),
    }));
    const allMisfits = classified.filter(({ wordClass }) =>
      isMisfit(wordClass),
    );
    if (allMisfits.length > MAX_PAIR_MISFITS) {
      limit ??= "misfit-words";
    }
    const best =
      allMisfits.length === 0
        ? null
        : bestPair({
            misfits: mostFrequent(allMisfits, MAX_PAIR_MISFITS),
            natives: classified.filter(
              ({ wordClass }) => wordClass === "native",
            ),
            alphabet,
            budget: { remaining: PAIR_EVALUATION_BUDGET },
          });
    if (best === "exhausted") {
      limit ??= "pair-evaluations";
    } else if (best !== null) {
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

  const [first, ...rest] = findings;
  if (first !== undefined) {
    return { status: "suspect", findings: [first, ...rest] };
  }
  return limit === undefined
    ? { status: "clean" }
    : { status: "incomplete", limit };
};
