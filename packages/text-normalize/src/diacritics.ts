/**
 * Latin/combining-mark diacritic stripping for search keys and slugs.
 *
 * Both variants decompose the input and then remove every character
 * Unicode classifies as a diacritic (`\p{Diacritic}`). `\p{Diacritic}`
 * is deliberate: it covers combining marks in every block, not only the
 * Combining Diacritical Marks block (U+0300–U+036F). A range like
 * `[̀-ͯ]` misses marks in the Extended (U+1AB0–U+1AFF) and
 * Supplement (U+1DC0–U+1DFF) blocks, so two callers using different
 * classes would disagree on the same text.
 *
 * The variants differ only in the decomposition form:
 *
 * - `stripDiacritics` uses NFD (canonical decomposition). Use it for
 *   search keys, where compatibility characters must survive unchanged.
 * - `stripDiacriticsForSlug` uses NFKD (compatibility decomposition), so
 *   ligatures, full-width forms, superscripts, and similar fold to their
 *   ASCII base before the `[a-z0-9]` slug filter runs. Slugs are
 *   persisted, public URL segments, so this variant pins the exact form
 *   the existing slugs were generated with; do not switch it to NFD.
 */

const DIACRITIC_RE = /\p{Diacritic}/gu;

/**
 * Strip combining diacritics from search text (NFD). Non-diacritic
 * characters, including compatibility characters, pass through unchanged.
 */
export const stripDiacritics = (text: string): string =>
  text.normalize("NFD").replace(DIACRITIC_RE, "");

/**
 * Strip combining diacritics for slug generation (NFKD). Callers apply
 * their own case folding and `[a-z0-9]` filtering around this; the NFKD
 * form is load-bearing for byte-stable slugs and must not change.
 */
export const stripDiacriticsForSlug = (text: string): string =>
  text.normalize("NFKD").replace(DIACRITIC_RE, "");
