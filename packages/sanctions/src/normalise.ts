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
  text
    .toLowerCase()
    .replaceAll(/\p{Script=Cyrillic}/gu, (char) => CYRILLIC[char] ?? char)
    .normalize("NFD")
    .replaceAll(/\p{M}/gu, "")
    .replaceAll(/[æðđħıłøœßþ]/gu, (char) => LATIN_SPECIAL[char] ?? char);

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

/** Maximum normalized input count, before repeated spellings are deduplicated. */
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
