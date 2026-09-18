import { stripDiacritics } from "@stll/text-normalize";

/**
 * Academic titles a court prints around a judge's name, folded the way
 * {@link titleShape} folds a token: lowercase, diacritics and punctuation
 * removed. The same person is printed with different titles by different
 * publishers and gains titles over a career, so they are never part of the
 * identity the roster is matched on.
 *
 * `et` joins two titles ("JUDr. et Mgr."); it is a connector between the
 * tokens above and never a name part.
 */
const ACADEMIC_TITLE_SHAPES: ReadonlySet<string> = new Set([
  "bc",
  "csc",
  "doc",
  "dr",
  "drsc",
  "et",
  "ing",
  "judr",
  "llm",
  "mgr",
  "mudr",
  "paeddr",
  "phd",
  "phdr",
  "prof",
  "rndr",
]);

/**
 * `dr. h. c.` is three tokens, and `h` and `c` are only titles inside it, so
 * the phrase is removed before the string is tokenized. Spacing and the final
 * full stop vary between publishers.
 */
const HONORARY_DOCTORATE_PATTERN = /\bdr\s*\.\s*h\s*\.\s*c\s*\.?/giu;

const WHITESPACE_PATTERN = /\s+/u;
const NON_ALPHANUMERIC_PATTERN = /[^\p{L}\p{N}]+/gu;
const NON_LETTER_PATTERN = /[^\p{L}]/gu;
const DANGLING_SEPARATOR_PATTERN = /^[\s,]+|[\s,]+$/gu;
const REPEATED_SEPARATOR_PATTERN = /,(?:\s*,)+/gu;

/** The comparable shape of one printed token: `Ph.D.,` and `phd` agree here. */
const titleShape = (token: string): string =>
  stripDiacritics(token).toLowerCase().replace(NON_LETTER_PATTERN, "");

/**
 * The name without the titles the publisher printed around it.
 *
 * Casing, diacritics and word order are the court's; only the title tokens
 * and the punctuation they leave behind are removed.
 */
export const stripAcademicTitles = (printed: string): string =>
  printed
    .replace(HONORARY_DOCTORATE_PATTERN, " ")
    .split(WHITESPACE_PATTERN)
    .filter((token) => !ACADEMIC_TITLE_SHAPES.has(titleShape(token)))
    .join(" ")
    .replace(REPEATED_SEPARATOR_PATTERN, ",")
    .replace(DANGLING_SEPARATOR_PATTERN, "");

/**
 * The key a printed name and a roster row are matched on.
 *
 * Two spellings of one judge (with or without titles, with or without
 * diacritics, spaced or punctuated differently) produce one key, and the key
 * is its own input: keying a key returns it unchanged.
 *
 * Word order is dropped because one court prints one judge both ways: the
 * Czech Constitutional Court's record card gives `Surname Firstname` while
 * its roster pages give `Firstname Surname`, and a key that kept the order
 * would leave every decision's bench unmatched.
 */
export const judgeNameKey = (printed: string): string =>
  stripDiacritics(stripAcademicTitles(printed))
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_PATTERN, " ")
    .trim()
    .split(WHITESPACE_PATTERN)
    .filter((part) => part.length > 0)
    .sort()
    .join("-");
