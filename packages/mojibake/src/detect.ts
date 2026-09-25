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
  DECODING_PAIRS,
  type DecodingPair,
  isEncodable,
  undoMisdecoding,
} from "./charsets.js";

/** Evidence below these counts is what a legitimate foreign name produces. */
const MIN_FIXED_OCCURRENCES = 3;
const MIN_FIXED_WORDS = 2;
/**
 * How many repaired occurrences a pair needs per word it would break. A text
 * that really went through the pair has almost no word it breaks: its
 * correctly-read words are the ones its charsets agree on.
 */
const FIXED_PER_DAMAGED = 4;
/** Two layers is double-encoded UTF-8; a third is not seen in practice. */
const MAX_LAYERS = 2;
const MIN_UTF8_SIGNATURE_OCCURRENCES = 2;
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
      /** Share of the evidence that agrees with the pair, 0..1. */
      confidence: number;
      fixedOccurrences: number;
      damagedOccurrences: number;
      samples: RepairedSpan[];
      /** The start of the text with the pair undone. */
      preview: string;
    };

export type EncodingFindingKind = EncodingFinding["kind"];

export type EncodingCheck =
  | { status: "clean" }
  | {
      status: "suspect";
      findings: readonly [EncodingFinding, ...EncodingFinding[]];
    };

type WordStat = { count: number; start: number };

type WordClass =
  /** Reads as the language: every letter native, at least one non-ASCII. */
  | "native"
  /** A letter the language does not write, a control, or a symbol inside a word. */
  | "misfit"
  /** Nothing either way: ASCII, digits, the language's own punctuation. */
  | "neutral";

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
const writtenInOneScript = (word: string): boolean => {
  const scripts = new Set<number>();
  for (const char of word) {
    if (!isLetter(char) || /\p{M}/u.test(char)) {
      continue;
    }
    const script = SCRIPTS.findIndex((pattern) => pattern.test(char));
    scripts.add(script);
  }
  return scripts.size <= 1;
};

const classifyWord = (word: string, alphabet: Alphabet): WordClass => {
  const chars = Array.from(word.normalize("NFC"));
  let nativeLetter = false;
  for (const [index, char] of chars.entries()) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < C1_FIRST) {
      continue;
    }
    if (isControlOrReplacement(cp)) {
      return "misfit";
    }
    if (isLetter(char)) {
      if (!alphabet.native.has(cp)) {
        return "misfit";
      }
      // A capital inside a lowercase word ("dignitÊ") is a letter read from
      // the wrong byte, not one a writer chose.
      const before = chars[index - 1];
      if (
        UPPERCASE.test(char) &&
        before !== undefined &&
        LOWERCASE.test(before)
      ) {
        return "misfit";
      }
      nativeLetter = true;
      continue;
    }
    if (alphabet.punctuation.has(cp)) {
      continue;
    }
    // A symbol standing apart ("¾ podílu", "m ²") is a symbol; one welded to
    // a letter ("pod¾a") stands where a letter was.
    const before = chars[index - 1];
    const after = chars[index + 1];
    if (
      (before !== undefined && isLetter(before)) ||
      (after !== undefined && isLetter(after))
    ) {
      return "misfit";
    }
  }
  if (!nativeLetter) {
    return "neutral";
  }
  // Every letter is the language's, but not every letter is one script's:
  // Bulgarian "Latvieрu" is Latvian "Latviešu" read through windows-1251,
  // and both alphabets allow each of its letters.
  return writtenInOneScript(word) ? "native" : "misfit";
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

const collectWords = (text: string): Map<string, WordStat> => {
  const words = new Map<string, WordStat>();
  for (const match of text.matchAll(WORD)) {
    const [word] = match;
    if (!NON_ASCII.test(word)) {
      continue;
    }
    const stat = words.get(word);
    if (stat === undefined) {
      words.set(word, { count: 1, start: match.index });
    } else {
      stat.count += 1;
    }
  }
  return words;
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
  fixedWords: number;
  damagedOccurrences: number;
  /** Native-looking words the pair turns into other native words. */
  convertedOccurrences: number;
  unresolvedOccurrences: number;
  samples: RepairedSpan[];
  /** Every word the pair changes, and what it changes it to. */
  repairs: ReadonlyMap<string, string>;
};

type ClassifiedWord = { word: string; stat: WordStat; wordClass: WordClass };

const pairEvidence = (
  words: readonly ClassifiedWord[],
  pair: DecodingPair,
  alphabet: Alphabet,
): PairEvidence | null => {
  let fixedOccurrences = 0;
  let fixedWords = 0;
  let unresolvedOccurrences = 0;
  let doubleLayered = 0;
  const samples: RepairedSpan[] = [];
  const repairs = new Map<string, string>();
  for (const { word, stat, wordClass } of words) {
    if (wordClass !== "misfit") {
      continue;
    }
    const repair = repairWord(word, { pair, alphabet, maxLayers: MAX_LAYERS });
    if (repair.status === "unrepaired") {
      unresolvedOccurrences += stat.count;
      continue;
    }
    fixedOccurrences += stat.count;
    fixedWords += 1;
    repairs.set(word, repair.text);
    if (repair.layers === 2) {
      doubleLayered += stat.count;
    }
    if (samples.length < MAX_SAMPLES) {
      samples.push({ ...span(word, stat), repaired: repair.text });
    }
  }
  if (
    fixedOccurrences < MIN_FIXED_OCCURRENCES ||
    fixedWords < MIN_FIXED_WORDS
  ) {
    return null;
  }
  // Only now the words that already read natively: a pair the text really
  // went through leaves them as they are, or turns them into other native
  // words (Polish "siź" is "się" through windows-1250 read as windows-1257),
  // and never breaks them.
  let damagedOccurrences = 0;
  let convertedOccurrences = 0;
  for (const { word, stat, wordClass } of words) {
    if (wordClass !== "native") {
      continue;
    }
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
    fixedWords,
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
  words: readonly ClassifiedWord[],
  alphabet: Alphabet,
): BestPair | null => {
  const accepted: PairEvidence[] = [];
  for (const pair of DECODING_PAIRS) {
    const evidence = pairEvidence(words, pair, alphabet);
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

const UTF8_SIGNATURE_PAIRS: readonly DecodingPair[] = (
  ["windows-1252", "iso-8859-1"] satisfies Charset[]
).map((assumed) => ({ actual: "utf-8", assumed }));

/**
 * Words that become valid UTF-8 with a non-ASCII letter once written back as
 * windows-1252 or Latin-1 bytes. A word a person wrote rarely spells a UTF-8
 * multi-byte sequence in those bytes, but capitals do: Czech "POSPÍŠIL" is
 * bytes CD 8A, a combining mark, and Slovak "VÝŠKA" is DD 8A, a Syriac one.
 * So where the language is known the word read back must read natively in
 * it; where it is not, it must at least stay in one script.
 */
const utf8Signature = (
  words: ReadonlyMap<string, WordStat>,
  alphabet: Alphabet | null,
): Extract<EncodingFinding, { kind: "utf8-read-as-single-byte" }> | null => {
  let occurrences = 0;
  const samples: RepairedSpan[] = [];
  for (const [word, stat] of words) {
    const repaired = UTF8_SIGNATURE_PAIRS.map((pair) =>
      undoWord(word, pair),
    ).find(
      (undone) =>
        !undone.failed &&
        undone.text !== word &&
        Array.from(undone.text).some(
          (char) => NON_ASCII.test(char) && isLetter(char),
        ) &&
        !Array.from(undone.text).some((char) =>
          isControlOrReplacement(char.codePointAt(0) ?? 0),
        ) &&
        (alphabet === null
          ? writtenInOneScript(undone.text)
          : classifyWord(undone.text, alphabet) === "native"),
    );
    if (repaired === undefined) {
      continue;
    }
    occurrences += stat.count;
    if (samples.length < MAX_SAMPLES) {
      samples.push({ ...span(word, stat), repaired: repaired.text });
    }
  }
  return occurrences >= MIN_UTF8_SIGNATURE_OCCURRENCES
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
  const alphabet = alphabetFor(language);
  const utf8 = utf8Signature(words, alphabet);
  if (utf8 !== null) {
    findings.push(utf8);
  }

  if (alphabet !== null) {
    const classified = Array.from(words).map(([word, stat]) => ({
      word,
      stat,
      wordClass: classifyWord(word, alphabet),
    }));
    const best = classified.some(({ wordClass }) => wordClass === "misfit")
      ? bestPair(classified, alphabet)
      : null;
    if (best !== null) {
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
            evidence.unresolvedOccurrences),
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
  return first === undefined
    ? { status: "clean" }
    : { status: "suspect", findings: [first, ...rest] };
};
