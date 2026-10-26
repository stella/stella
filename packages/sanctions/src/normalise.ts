import { stripUnicodeMarks } from "@stll/text-normalize";

import type { EntityType } from "./entry";

// Scholarly-neutral Cyrillic romanisation covering Russian, Ukrainian,
// Belarusian, Bulgarian, Serbian and Macedonian letters. Lists already carry
// Latin aliases, so this only has to land near one of them; the folding below
// absorbs the remaining transcription differences.
const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
  ў: "u",
  ђ: "dj",
  ј: "j",
  љ: "lj",
  њ: "nj",
  ћ: "c",
  џ: "dz",
  ѓ: "g",
  ќ: "k",
  ѕ: "dz",
};

// Latin letters NFD does not decompose into a base letter plus a mark.
const LATIN_SPECIAL: Readonly<Record<string, string>> = {
  æ: "ae",
  ð: "d",
  đ: "d",
  ħ: "h",
  ı: "i",
  ł: "l",
  ø: "o",
  œ: "oe",
  ß: "ss",
  þ: "th",
};

// One canonical spelling per sound that transcriptions of the same name
// disagree on (Czech "Michajlovič", English "Mikhailovich", German
// "Michailowitsch", Swedish "Michajlovitj", Polish "Michajłowicz"). Applied
// identically to list aliases and queries, so it can only merge spellings,
// never split a name from itself.
const FOLDS: Readonly<Record<string, string>> = {
  shch: "s",
  sch: "s",
  sh: "s",
  sj: "s",
  sz: "s",
  tsch: "c",
  tch: "c",
  ts: "c",
  tz: "c",
  ch: "c",
  cz: "c",
  kh: "c",
  tj: "c",
  zh: "z",
  zj: "z",
  ph: "f",
  ck: "k",
  q: "k",
  ks: "x",
  w: "v",
  ou: "u",
  j: "i",
  y: "i",
};
// Longer spellings first, so "shch" wins over "sh" at the same position.
const FOLD_PATTERN = new RegExp(
  Object.keys(FOLDS)
    .toSorted((left, right) => right.length - left.length)
    .join("|"),
  "gu",
);
const REPEATED_LETTER = /(\p{L})\1+/gu;

// Legal-form abbreviations, written either run together ("sro", "ooo") or
// dotted ("s.r.o.", "O.O.O."), which tokenises letter by letter.
const LEGAL_FORM_ABBREVIATIONS = [
  "ag",
  "ao",
  "as",
  "bv",
  "cjsc",
  "fz",
  "fzc",
  "fzco",
  "fze",
  "fzllc",
  "gmbh",
  "jsc",
  "kg",
  "ks",
  "llc",
  "llp",
  "lp",
  "nv",
  "oao",
  "ojsc",
  "ooo",
  "pao",
  "pjsc",
  "plc",
  "sa",
  "sarl",
  "se",
  "spa",
  "sro",
  "srl",
  "vos",
  "zao",
  "zs",
];

// Legal-form designations as token runs, stripped from either end of an
// organisation name and never from its middle. Hyphens and dots already split
// tokens, and stripping repeats, so stacked forms ("LLC-FZ", "Limited
// Liability Company - Free Zone") go whole in any spelling. Longest first, so
// "joint stock company" goes whole rather than leaving "joint stock" behind.
const LEGAL_FORMS: readonly (readonly string[])[] = [
  ...LEGAL_FORM_ABBREVIATIONS.flatMap((form) => [[form], Array.from(form)]),
  ["co"],
  ["company"],
  ["corp"],
  ["corporation"],
  ["inc"],
  ["incorporated"],
  ["limited"],
  ["ltd"],
  ["spol"],
  ["joint", "stock", "company"],
  ["public", "joint", "stock", "company"],
  ["open", "joint", "stock", "company"],
  ["closed", "joint", "stock", "company"],
  ["limited", "liability", "company"],
  ["free", "zone"],
  ["free", "zone", "company"],
  ["free", "zone", "establishment"],
  ["akciova", "spolecnost"],
  ["spolecnost", "s", "rucenim", "omezenym"],
  ["sp", "z", "o", "o"],
  ["obshchestvo", "s", "ogranichennoy", "otvetstvennostyu"],
  ["publichnoe", "aktsionernoe", "obshchestvo"],
  ["otkrytoe", "aktsionernoe", "obshchestvo"],
  ["zakrytoe", "aktsionernoe", "obshchestvo"],
  ["aktsionernoe", "obshchestvo"],
].toSorted((left, right) => right.length - left.length);

const toLatin = (text: string): string =>
  stripUnicodeMarks(
    text
      .toLowerCase()
      .replaceAll(/\p{Script=Cyrillic}/gu, (char) => CYRILLIC[char] ?? char),
    { form: "NFD", markClass: "combining" },
  ).replaceAll(/[æðđħıłøœßþ]/gu, (char) => LATIN_SPECIAL[char] ?? char);

const startsWithRun = (
  tokens: readonly string[],
  run: readonly string[],
  offset: number,
): boolean => run.every((part, index) => tokens[offset + index] === part);

/** The longest legal form found at `at`, leaving at least one other token. */
const longestFormAt = (
  tokens: readonly string[],
  at: (form: readonly string[]) => number,
  remaining: number,
): readonly string[] | undefined =>
  LEGAL_FORMS.find(
    (form) => remaining > form.length && startsWithRun(tokens, form, at(form)),
  );

// Strips the longest legal form at either end, then looks again from the
// longest, so a short form never splits a longer one it ends ("company" out of
// "limited liability company").
const stripLegalForms = (tokens: readonly string[]): string[] => {
  let start = 0;
  let end = tokens.length;
  for (;;) {
    const from = start;
    const to = end;
    const leading = longestFormAt(tokens, () => from, to - from);
    if (leading !== undefined) {
      start += leading.length;
      continue;
    }
    const trailing = longestFormAt(
      tokens,
      (form) => to - form.length,
      to - from,
    );
    if (trailing === undefined) {
      return tokens.slice(start, end);
    }
    end -= trailing.length;
  }
};

const fold = (token: string): string =>
  token
    .replace(FOLD_PATTERN, (spelling) => FOLDS[spelling] ?? spelling)
    .replace(REPEATED_LETTER, "$1");

/**
 * A comparable name token: `raw` is lower-case Latin without diacritics
 * (Cyrillic transliterated); `folded` also merges transcription variants.
 * Matching compares both, because folding absorbs "Michajlovič" against
 * "Mikhailovich" but turns a typo inside a digraph ("Gutpseriev") into
 * several edits.
 */
export type NameToken = { raw: string; folded: string };

/**
 * Splits a name into comparable tokens: punctuation removed and, for an
 * organisation, legal forms stripped.
 */
export const nameTokens = (
  name: string,
  entityType: EntityType,
): NameToken[] => {
  const raw = toLatin(name)
    // Apostrophes join ("O'Neil", "Ma'ruf"); other punctuation separates.
    .replaceAll(/['’ʼ`´]/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");
  const tokens = entityType === "person" ? raw : stripLegalForms(raw);
  return tokens.map((token) => ({ raw: token, folded: fold(token) }));
};

// Lists and parties write one name with a bracketed qualifier ("KOREA KWANGSON
// BANKING CORPORATION (KKBC)", "AL-HARAMAYN FOUNDATION (KENYA)") or join
// several names with " ; ", while another list or a party writes the same name
// without them. Every name, listed or queried, is therefore read whole, per
// joined name, and without its bracketed parts. A bracketed part that is
// itself a name is also read on its own, as a weak alias: an acronym of the
// rest, text marked as an alias, or the name in another script. Places, notes
// and spelling variants in brackets never stand alone.
const OPENERS = new Set(["(", "[", "（", "［"]);
const CLOSERS = new Set([")", "]", "）", "］"]);
const ALIAS_MARKER =
  /^(?:previously\s+listed\s+as|previously\s+known\s+as|formerly\s+known\s+as|also\s+known\s+as|known\s+as|original\s+script|former\s+name|formerly|previously|a\.?\s*k\.?\s*a|f\.?\s*k\.?\s*a|n\.?\s*k\.?\s*a)(?:[\s.:,-]+|$)/iu;
const ACRONYM_SHAPE = /^[\p{L}\s.&/'’-]+$/u;
const MAX_ACRONYM_LETTERS = 10;
const LATIN = /\p{Script=Latin}/u;
const NAME_CHARACTER = /[\p{L}\p{N}]/u;

const tidy = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

type NameSegment = { text: string; base: string; qualifiers: string[] };

/**
 * Splits a name at top-level semicolons and lifts its top-level bracketed
 * parts out. Nested brackets stay inside their part; an unclosed bracket runs
 * to the end of the name and a stray closing one separates words.
 */
const nameSegments = (name: string): NameSegment[] => {
  const segments: NameSegment[] = [];
  let segment: NameSegment = { text: "", base: "", qualifiers: [] };
  let group = "";
  let depth = 0;
  for (const char of name) {
    if (depth === 0 && char === ";") {
      segments.push(segment);
      segment = { text: "", base: "", qualifiers: [] };
      continue;
    }
    segment.text += char;
    if (OPENERS.has(char)) {
      depth += 1;
      if (depth === 1) {
        segment.base += " ";
      } else {
        group += " ";
      }
    } else if (CLOSERS.has(char)) {
      if (depth === 0) {
        segment.base += " ";
      } else if (depth === 1) {
        depth = 0;
        segment.qualifiers.push(group);
        group = "";
      } else {
        depth -= 1;
        group += " ";
      }
    } else if (depth > 0) {
      group += char;
    } else {
      segment.base += char;
    }
  }
  if (depth > 0) {
    segment.qualifiers.push(group);
  }
  segments.push(segment);
  return segments;
};

/**
 * Whether `letters` abbreviate `words`: each letter, in order, either starts
 * one of the following words or continues the word the previous letter came
 * from ("SAPICO" for "SAhand Aluminum Parts Industrial COmpany"), drawing on
 * at least two words.
 */
const abbreviates = (letters: string, words: readonly string[]): boolean => {
  const failed = new Set<string>();
  const visit = (at: number, from: number, used: number): boolean => {
    if (at === letters.length) {
      return used >= 2;
    }
    const state = `${at}:${from}:${Math.min(used, 2)}`;
    if (failed.has(state)) {
      return false;
    }
    for (let word = from; word < words.length; word += 1) {
      const text = words[word] ?? "";
      if (text[0] !== letters[at]) {
        continue;
      }
      let spelled = 1;
      for (
        let index = 1;
        index < text.length && at + spelled < letters.length;
        index += 1
      ) {
        if (text[index] === letters[at + spelled]) {
          spelled += 1;
        }
      }
      for (let take = spelled; take >= 1; take -= 1) {
        if (visit(at + take, word + 1, used + 1)) {
          return true;
        }
      }
    }
    failed.add(state);
    return false;
  };
  return visit(0, 0, 0);
};

const isAcronymOf = (candidate: string, base: string): boolean => {
  if (!ACRONYM_SHAPE.test(candidate)) {
    return false;
  }
  const letters = toLatin(candidate).replaceAll(/[^\p{L}]/gu, "");
  if (letters.length < 2 || letters.length > MAX_ACRONYM_LETTERS) {
    return false;
  }
  const words = toLatin(base)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  return abbreviates(letters, words);
};

/** The names a bracketed part stands for on its own, if any. */
const qualifierNames = (qualifier: string, base: string): string[] => {
  const marked = ALIAS_MARKER.exec(tidy(qualifier));
  if (marked !== null) {
    return tidy(qualifier).slice(marked[0].length).split(";").map(tidy);
  }
  return qualifier
    .split(/[;,]/u)
    .map(tidy)
    .filter(
      (candidate) =>
        isAcronymOf(candidate, base) ||
        (NAME_CHARACTER.test(candidate) &&
          NAME_CHARACTER.test(base) &&
          LATIN.test(candidate) !== LATIN.test(base)),
    );
};

/**
 * One spelling a name stands for. `qualifier` marks a bracketed part read on
 * its own, which counts as a weak alias wherever it matches.
 */
export type NameVariant = { text: string; qualifier: boolean };

/**
 * Every spelling a listed or queried name stands for: the name itself, each
 * semicolon-joined name, each without its bracketed parts, then the bracketed
 * parts that are names in their own right. The one owner of bracket handling,
 * applied identically to list aliases and queries.
 */
export const nameVariants = (name: string): NameVariant[] => {
  const variants = new Map<string, boolean>();
  const add = (text: string, qualifier: boolean) => {
    const tidied = tidy(text);
    if (NAME_CHARACTER.test(tidied) && !variants.has(tidied)) {
      variants.set(tidied, qualifier);
    }
  };
  add(name, false);
  const segments = nameSegments(name);
  if (segments.length > 1) {
    for (const segment of segments) {
      add(segment.text, false);
    }
  }
  for (const segment of segments) {
    add(segment.base, false);
  }
  for (const segment of segments) {
    for (const qualifier of segment.qualifiers) {
      for (const text of qualifierNames(qualifier, segment.base)) {
        add(text, true);
      }
    }
  }
  return Array.from(variants, ([text, qualifier]) => ({ text, qualifier }));
};

/** Maximum normalized input count, before repeated spellings are deduplicated. */
export const MAX_QUERY_CHARACTERS = 512;
export const MAX_QUERY_TOKENS = 24;

export const hasExcessQueryTokens = (
  name: string,
  entityType: EntityType,
): boolean => nameTokens(name, entityType).length > MAX_QUERY_TOKENS;

export type NameReading = {
  tokens: NameToken[];
  adjacent: [number, number][];
};

/** Deduplicate spellings without inventing or losing original adjacent pairs. */
export const nameReading = (
  name: string,
  entityType: EntityType,
): NameReading => {
  const tokens: NameToken[] = [];
  const positions = new Map<string, number>();
  const adjacent: [number, number][] = [];
  const seen = new Set<string>();
  let previous: number | undefined;
  for (const token of nameTokens(name, entityType)) {
    let position = positions.get(token.raw);
    if (position === undefined) {
      position = tokens.length;
      positions.set(token.raw, position);
      tokens.push(token);
    }
    if (previous !== undefined) {
      const key = `${previous}:${position}`;
      if (!seen.has(key)) {
        adjacent.push([previous, position]);
        seen.add(key);
      }
    }
    previous = position;
  }
  return { tokens, adjacent };
};

/** Identity of a reading: two readings with one key score identically. */
export const readingKey = ({ tokens, adjacent }: NameReading): string =>
  `${tokens.map((token) => token.raw).join(" ")}|${adjacent.join(";")}`;

export type NameVariantReading = { reading: NameReading; qualifier: boolean };

/**
 * The distinct non-empty readings of every variant of a name, the whole name
 * first. A reading shared by the name and a bracketed part stays full weight.
 */
export const nameReadings = (
  name: string,
  entityType: EntityType,
): NameVariantReading[] => {
  const readings = new Map<string, NameVariantReading>();
  for (const { text, qualifier } of nameVariants(name)) {
    const reading = nameReading(text, entityType);
    const key = readingKey(reading);
    if (reading.tokens.length > 0 && !readings.has(key)) {
      readings.set(key, { reading, qualifier });
    }
  }
  return [...readings.values()];
};
