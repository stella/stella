import { Result } from "better-result";

import { CLDR_EXEMPLARS } from "./exemplars.generated.js";

/**
 * Which characters a language writes, read from its CLDR exemplar sets.
 *
 * `native` is the main exemplar set (letters the language's own words are
 * spelled with) in both cases, plus ASCII letters, which every corpus text
 * carries in identifiers and citations whatever its language. `punctuation`
 * is the language's own punctuation exemplars; a quotation mark the language
 * writes is not evidence of anything, wherever it stands.
 */
export type Alphabet = {
  language: string;
  native: ReadonlySet<number>;
  punctuation: ReadonlySet<number>;
};

type ExemplarTag = keyof typeof CLDR_EXEMPLARS;

const isExemplarTag = (tag: string): tag is ExemplarTag =>
  Object.hasOwn(CLDR_EXEMPLARS, tag);

const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const codePoints = (text: string): number[] =>
  Array.from(text).map((char) => char.codePointAt(0) ?? 0);

/** A character and its single-character case variants. */
const caseForms = (char: string): string[] =>
  [char, char.toLowerCase(), char.toUpperCase()].filter(
    (form) => Array.from(form).length === 1,
  );

const buildAlphabet = (tag: ExemplarTag): Alphabet => {
  const { main, punctuation } = CLDR_EXEMPLARS[tag];
  const native = new Set(codePoints(ASCII_LETTERS));
  for (const char of main) {
    for (const form of caseForms(char)) {
      native.add(form.codePointAt(0) ?? 0);
    }
  }
  return {
    language: tag,
    native,
    punctuation: new Set(codePoints(punctuation)),
  };
};

const alphabets = new Map<ExemplarTag, Alphabet>();

/**
 * The alphabet of a BCP-47 tag: the language written in the tag's script
 * where CLDR distinguishes it, else the language. Null for a tag CLDR has no
 * exemplars for, or one that is not a well-formed tag: the detector then
 * falls back to the signatures that need no alphabet.
 */
export const alphabetFor = (languageTag: string): Alphabet | null => {
  const locale = Result.try(() => new Intl.Locale(languageTag)).unwrapOr(null);
  if (locale === null) {
    return null;
  }
  const candidates = [
    locale.script === undefined ? null : `${locale.language}-${locale.script}`,
    locale.language,
  ];
  const tag = candidates.find(
    (candidate): candidate is ExemplarTag =>
      candidate !== null && isExemplarTag(candidate),
  );
  if (tag === undefined) {
    return null;
  }
  const cached = alphabets.get(tag);
  if (cached !== undefined) {
    return cached;
  }
  const alphabet = buildAlphabet(tag);
  alphabets.set(tag, alphabet);
  return alphabet;
};
