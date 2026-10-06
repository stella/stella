/**
 * Latin/combining-mark diacritic stripping for search keys and slugs.
 *
 * Both variants decompose the input and then remove characters Unicode
 * classifies as diacritics (`\p{Diacritic}`). `\p{Diacritic}` is
 * deliberate: it covers combining marks in every block, not only the
 * Combining Diacritical Marks block (U+0300–U+036F). A range like
 * `[̀-ͯ]` misses marks in the Extended (U+1AB0–U+1AFF) and
 * Supplement (U+1DC0–U+1DFF) blocks, so two callers using different
 * classes would disagree on the same text.
 *
 * The variants differ in decomposition form and in what they remove:
 *
 * - `stripDiacritics` uses NFD (canonical decomposition) and removes
 *   `SEARCH_DIACRITIC_SOURCE`. Use it for search keys, where compatibility
 *   characters and non-Latin spacing marks (`ー`, `·`) survive unchanged.
 * - `stripDiacriticsForSlug` uses NFKD (compatibility decomposition), so
 *   ligatures, full-width forms, superscripts, and similar fold to their
 *   ASCII base before the `[a-z0-9]` slug filter runs. Slugs are
 *   persisted, public URL segments, so this variant pins the exact form
 *   the existing slugs were generated with, spacing diacritics removed
 *   too; do not switch it to NFD or narrow its class.
 */

/**
 * The diacritics a search fold removes: combining marks, plus spacing ones in
 * Latin script (modifier letters such as `ʰ`).
 *
 * `\p{Diacritic}` alone also covers spacing characters in other scripts that
 * are text, not marks on a letter: the Japanese prolonged sound mark
 * (`コーヒー`), the middle dot (`l·l`), `^`, and `` ` ``. Removing those turns
 * `コーヒー` into `コヒ`, a different word, and PostgreSQL `unaccent()` keeps
 * them, so a query folded that way misses the indexed text. Latin script keeps
 * the full class because `foldToAscii` is pinned to `unaccent()` parity there.
 * Shared as a source string so `foldToAscii` strips the identical class.
 */
export const SEARCH_DIACRITIC_SOURCE =
  "(?=\\p{M}|\\p{Script=Latin})\\p{Diacritic}";

const SEARCH_DIACRITIC_RE = new RegExp(SEARCH_DIACRITIC_SOURCE, "gu");

/**
 * Pinned to the class the persisted slugs were minted with, spacing
 * characters included; see `stripDiacriticsForSlug`.
 */
const SLUG_DIACRITIC_RE = /\p{Diacritic}/gu;

/**
 * Strip combining diacritics from search text (NFD). Non-diacritic
 * characters, including compatibility characters and spacing marks such as
 * `ー`, pass through unchanged.
 */
export const stripDiacritics = (text: string): string =>
  text.normalize("NFD").replace(SEARCH_DIACRITIC_RE, "");

/**
 * Strip combining diacritics for slug generation (NFKD). Callers apply
 * their own case folding and `[a-z0-9]` filtering around this; the NFKD
 * form is load-bearing for byte-stable slugs and must not change.
 */
export const stripDiacriticsForSlug = (text: string): string =>
  text.normalize("NFKD").replace(SLUG_DIACRITIC_RE, "");
