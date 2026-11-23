/**
 * Bytes that declare no charset, read as the charset they were written in.
 *
 * Valid UTF-8 is UTF-8: no legacy text of more than a few letters happens to
 * form valid multi-byte sequences, so a strict UTF-8 reading that succeeds is
 * the answer and nothing below runs. UTF-8 whose only defect is a sequence
 * cut off at the very end (a truncated preview) is UTF-8 too.
 *
 * Anything else was written by a program that used a legacy code page,
 * typically a Central European (windows-1250, ISO-8859-2) or Western
 * (windows-1252) one. Each candidate's reading is scored against the CLDR
 * exemplar letters of the languages those code pages write:
 *
 * - the bytes are split into words at every ASCII byte that is not a letter,
 *   which every candidate reads alike, and only words holding a byte above
 *   0x7F are weighed;
 * - a word read as U+FFFD or a C1 control character costs its occurrences;
 * - a candidate's score is the occurrences of the words that one language
 *   writes entirely in its letters and punctuation, for the language that
 *   explains the most, less those costs; lossy UTF-8 instead counts every
 *   word it reads without U+FFFD, in any script.
 *
 * The right reading explains every word in the text's own language; a wrong
 * one turns some of them into letters no single language writes together
 * ("øízení" for "řízení"). Lossy UTF-8 is a candidate too, so mostly-UTF-8
 * text with one stray byte keeps its UTF-8 letters. A tie goes to the earlier
 * candidate in `UNDECLARED_CHARSETS`.
 */

import { Result } from "better-result";

import { type Alphabet, alphabetFor } from "./alphabet.js";
import { decodeDosCodePage, type DosCodePage } from "./dos-code-pages.js";

/** The readings weighed, in the order a tie is settled. */
const UNDECLARED_CHARSETS = [
  "utf-8",
  "windows-1250",
  "windows-1252",
  "iso-8859-2",
] as const;

type UndeclaredCharset = (typeof UNDECLARED_CHARSETS)[number];

type UndeclaredText = { text: string; charset: UndeclaredCharset };

/**
 * The readings weighed for file names a ZIP archive stores without its UTF-8
 * flag, in the order a tie is settled. The ZIP specification gives such
 * names code page 437; Windows writes them in its OEM code page (852 in
 * Central Europe), and some archivers in its ANSI one.
 */
const UNDECLARED_FILE_NAME_CHARSETS = [
  "ibm437",
  "ibm852",
  "windows-1250",
  "windows-1252",
] as const;

type FileNameCharset = (typeof UNDECLARED_FILE_NAME_CHARSETS)[number];

/** Reads bytes in a charset; a byte the charset leaves undefined is U+FFFD. */
const reader = (
  charset: UndeclaredCharset | FileNameCharset,
): ((bytes: Uint8Array) => string) => {
  if (charset === "ibm437" || charset === "ibm852") {
    const codePage: DosCodePage = charset;
    return (bytes) => decodeDosCodePage(bytes, codePage);
  }
  const decoder = new TextDecoder(charset);
  return (bytes) => decoder.decode(bytes);
};

/**
 * Languages whose letters the legacy candidates write: the Central European
 * ones of windows-1250 and ISO-8859-2, and the Western ones of windows-1252.
 */
const SCORED_LANGUAGES = [
  "cs",
  "sk",
  "pl",
  "hu",
  "sl",
  "hr",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "nl",
  "sv",
  "da",
  "nb",
  "fi",
] as const;

/**
 * Bounds on the work one guess does: the first distinct words seen are
 * weighed, and a longer run of letters is not a word anyone wrote.
 */
const MAX_SCORED_WORDS = 4096;
const MAX_SCORED_WORD_BYTES = 64;

const REPLACEMENT_CHARACTER = 0xff_fd;
const FIRST_C1 = 0x80;
const LAST_C1 = 0x9f;

const isAsciiLetterByte = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

const isWordByte = (byte: number): boolean =>
  byte > 0x7f || isAsciiLetterByte(byte);

type ScoredWord = { bytes: Uint8Array; occurrences: number };

/** Each distinct word holding a byte above 0x7F, with how often it occurs. */
const nonAsciiWords = (bytes: Uint8Array): ScoredWord[] => {
  const words = new Map<string, ScoredWord>();
  let start = 0;
  const flush = (end: number): void => {
    const length = end - start;
    if (length === 0 || length > MAX_SCORED_WORD_BYTES) {
      return;
    }
    const word = bytes.subarray(start, end);
    if (word.every((byte) => byte <= 0x7f)) {
      return;
    }
    const key = String.fromCodePoint(...word);
    const seen = words.get(key);
    if (seen !== undefined) {
      seen.occurrences += 1;
    } else if (words.size < MAX_SCORED_WORDS) {
      words.set(key, { bytes: word, occurrences: 1 });
    }
  };
  for (let index = 0; index < bytes.length; index += 1) {
    if (!isWordByte(bytes[index] ?? 0)) {
      flush(index);
      start = index + 1;
    }
  }
  flush(bytes.length);
  return [...words.values()];
};

const isBroken = (word: string): boolean => {
  for (const char of word) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint === REPLACEMENT_CHARACTER ||
      (codePoint >= FIRST_C1 && codePoint <= LAST_C1)
    ) {
      return true;
    }
  }
  return false;
};

const writes = (alphabet: Alphabet, word: string): boolean => {
  for (const char of word) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      !alphabet.native.has(codePoint) &&
      !alphabet.punctuation.has(codePoint)
    ) {
      return false;
    }
  }
  return true;
};

const scoredAlphabets = (): Alphabet[] =>
  SCORED_LANGUAGES.flatMap((language) => alphabetFor(language) ?? []);

const score = (
  words: readonly ScoredWord[],
  charset: UndeclaredCharset | FileNameCharset,
  alphabets: readonly Alphabet[],
): number => {
  const read = reader(charset);
  const explained = alphabets.map(() => 0);
  // A word whose bytes form valid UTF-8 sequences is UTF-8 whatever script
  // it writes: legacy text does not form them by chance.
  let validUtf8 = 0;
  let cost = 0;
  for (const { bytes, occurrences } of words) {
    const word = read(bytes);
    if (isBroken(word)) {
      cost += occurrences;
      continue;
    }
    if (charset === "utf-8") {
      validUtf8 += occurrences;
      continue;
    }
    for (const [index, alphabet] of alphabets.entries()) {
      if (writes(alphabet, word)) {
        explained[index] = (explained[index] ?? 0) + occurrences;
      }
    }
  }
  return Math.max(validUtf8, ...explained) - cost;
};

/**
 * The bytes as strict UTF-8, or null when they are not. A multi-byte sequence
 * cut off at the end reads as U+FFFD, as a lenient decoder reads it.
 */
const strictUtf8 = (bytes: Uint8Array): string | null => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const head = Result.try(() => decoder.decode(bytes, { stream: true }));
  if (head.isErr()) {
    return null;
  }
  const tail = Result.try(() => decoder.decode());
  return tail.isOk()
    ? `${head.value}${tail.value}`
    : `${head.value}${String.fromCodePoint(REPLACEMENT_CHARACTER)}`;
};

/** The candidate whose reading of the bytes scores highest; ties go first. */
const bestReading = <Charset extends UndeclaredCharset | FileNameCharset>(
  bytes: Uint8Array,
  candidates: readonly [Charset, ...Charset[]],
): Charset => {
  const words = nonAsciiWords(bytes);
  const alphabets = scoredAlphabets();
  let [best] = candidates;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const charset of candidates) {
    const candidate = score(words, charset, alphabets);
    if (candidate > bestScore) {
      best = charset;
      bestScore = candidate;
    }
  }
  return best;
};

/**
 * Bytes that declare no charset, read as UTF-8 when they are UTF-8 and
 * otherwise as the candidate whose reading scores highest.
 */
export const decodeUndeclared = (bytes: Uint8Array): UndeclaredText => {
  const utf8 = strictUtf8(bytes);
  if (utf8 !== null) {
    return { text: utf8, charset: "utf-8" };
  }
  const charset = bestReading(bytes, UNDECLARED_CHARSETS);
  return { text: new TextDecoder(charset).decode(bytes), charset };
};

/** Separates names joined for scoring: an ASCII byte that ends a word. */
const NAME_SEPARATOR = 0x2f;

/**
 * The file names one archive stores without a declared charset, in order.
 *
 * A name that is valid UTF-8 is UTF-8: archivers that write UTF-8 without
 * setting the flag are common, and a legacy name of accented letters is
 * almost never valid UTF-8. The other names were written by one program in
 * one code page, so they are weighed together and all read in the candidate
 * that explains them best (`UNDECLARED_FILE_NAME_CHARSETS`); code page 437,
 * the specification's, wins a tie, as when no name holds a letter that
 * tells the candidates apart.
 */
export const decodeUndeclaredFileNames = (
  names: readonly Uint8Array[],
): { names: string[]; charset: FileNameCharset | null } => {
  const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const utf8 = names.map((name) =>
    Result.try(() => fatalUtf8.decode(name)).unwrapOr(null),
  );
  const legacy = names.filter((_, index) => utf8[index] === null);
  if (legacy.length === 0) {
    return { names: utf8.map((name) => name ?? ""), charset: null };
  }
  const joined = new Uint8Array(
    legacy.reduce((length, name) => length + name.byteLength + 1, 0),
  );
  let offset = 0;
  for (const name of legacy) {
    joined.set(name, offset);
    joined[offset + name.byteLength] = NAME_SEPARATOR;
    offset += name.byteLength + 1;
  }
  const charset = bestReading(joined, UNDECLARED_FILE_NAME_CHARSETS);
  const read = reader(charset);
  return {
    names: names.map((name, index) => utf8[index] ?? read(name)),
    charset,
  };
};
