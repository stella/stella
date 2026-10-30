// parser-output-unchanged: no case-law or legislation adapter or parser calls slugify; adapters reach this module only through the package index.
/**
 * One slug generator for the key-shaped strings the apps derive from a label.
 *
 * Four copies of this loop existed, differing only in their separator, their
 * budget, their fallback, and whether a non-ASCII letter survives. Those four
 * are the parameters; everything else — lowercase, collapse a run of rejected
 * characters into one separator, clip, trim a trailing separator, fall back
 * when nothing is left — was identical in all four and is fixed here.
 *
 * The `ascii` charset transliterates Latin letters before filtering:
 * `slugify("Łódź")` is `"lodz"`, not `"odz"`. A key minted before
 * transliteration is not recomputed by its owner; a caller that re-derives a
 * stored key at lookup (the case-law routes) recognises the earlier fold
 * itself.
 *
 * Single-pass by construction: a regex pipeline over untrusted label text is
 * what the slow-regex guard exists to prevent.
 */

import { applyAsciiFolds } from "./ascii-fold.js";

/**
 * Which characters survive.
 *
 * - `ascii` keeps `[a-z0-9]`, for keys that end up in URLs and columns
 *   validated against that charset. Latin letters are transliterated first.
 * - `unicode` keeps any Unicode letter or number, for paths shown back to the
 *   person who typed them.
 */
export type SlugCharset = "ascii" | "unicode";

/**
 * The delimiters callers use: a hyphen for URL and column keys, an underscore
 * for field paths.
 *
 * A closed union rather than a `string`, because an empty separator would make
 * the trim loop below spin forever — `"".endsWith("")` is true and
 * `slice(0, -0)` is the whole string. A caller cannot reach that state now.
 */
export type SlugSeparator = "-" | "_";

export type SlugifyOptions = {
  readonly charset: SlugCharset;
  /** Joins the surviving runs. */
  readonly separator: SlugSeparator;
  /** Budget the result is clipped to, before the trailing separator is cut. */
  readonly maxLength: number;
  /** Returned when nothing survives, so a caller always gets a usable key. */
  readonly fallback: string;
};

const UNICODE_SLUG_CHARACTER = /[\p{L}\p{N}]/u;

/** Compatibility decomposition, the search fold's mark strip and the table. */
const spellInAscii = (text: string): string =>
  applyAsciiFolds(text.normalize("NFKD"));

/**
 * Latin letters spelled in ASCII: compatibility decomposition (`ﬁ`, `Ａ`), the
 * search fold's mark strip (`č`), and the `unaccent()` table for letters no
 * decomposition reaches (`ł`, `ø`, `ß`, `þ`, `ı`). The table is not closed
 * under case (`Ɩ` folds and its small letter `ɩ` does not; `ɡ` folds and its
 * capital `Ɡ` does not), so it applies on both sides of the lowercase. Other
 * scripts pass through and are filtered out.
 */
const transliterateToAscii = (value: string): string =>
  spellInAscii(spellInAscii(value).toLowerCase()).toLowerCase();

const isSlugCharacter = (character: string, charset: SlugCharset): boolean => {
  if (charset === "unicode") {
    return UNICODE_SLUG_CHARACTER.test(character);
  }
  return (
    (character >= "a" && character <= "z") ||
    (character >= "0" && character <= "9")
  );
};

export const slugify = (
  value: string,
  { charset, separator, maxLength, fallback }: SlugifyOptions,
): string => {
  const source =
    charset === "ascii" ? transliterateToAscii(value) : value.toLowerCase();
  let buffer = "";
  let lastWasSeparator = true;

  for (const character of source) {
    if (isSlugCharacter(character, charset)) {
      buffer += character;
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator) {
      buffer += separator;
      lastWasSeparator = true;
    }
  }

  let clipped = "";
  for (const character of buffer) {
    if (clipped.length + character.length > maxLength) {
      break;
    }
    clipped += character;
  }
  // Every separator is one character, so the trim shortens by one per pass.
  while (clipped.endsWith(separator)) {
    clipped = clipped.slice(0, -1);
  }

  return clipped || fallback;
};
