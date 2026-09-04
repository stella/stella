/**
 * One slug generator for the key-shaped strings the apps derive from a label.
 *
 * Four copies of this loop existed, differing only in their separator, their
 * budget, their fallback, and whether a non-ASCII letter survives. Those four
 * are the parameters; everything else — lowercase, collapse a run of rejected
 * characters into one separator, clip, trim a trailing separator, fall back
 * when nothing is left — was identical in all four and is fixed here.
 *
 * Deliberately does NOT transliterate. `slugify("café")` is `"caf"` under the
 * `ascii` charset, not `"cafe"`: slugs are persisted, and folding here would
 * quietly start minting different keys for the same labels. The folding
 * primitives in this package are for search text, where nothing is stored.
 *
 * Single-pass by construction: a regex pipeline over untrusted label text is
 * what the slow-regex guard exists to prevent.
 */

/**
 * Which characters survive.
 *
 * - `ascii` keeps `[a-z0-9]`, for keys that end up in URLs and columns
 *   validated against that charset.
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
  let buffer = "";
  let lastWasSeparator = true;

  for (const character of value.toLowerCase()) {
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

  // Every separator is one character, so the trim shortens by one per pass.
  let clipped = buffer.slice(0, maxLength);
  while (clipped.endsWith(separator)) {
    clipped = clipped.slice(0, -1);
  }

  return clipped || fallback;
};
