/**
 * Morphological stemming for legal-corpus terms.
 *
 * Czech and Polish run the official Snowball algorithms, generated from the
 * pinned v3.1.1 release (see `./snowball/`). Slovak has no Snowball algorithm
 * and runs Wikimedia's light stemmer instead (see `./slovak`); all three are
 * the same Dolamic and Savoy light-stemming family, so their aggressiveness
 * is comparable.
 *
 * Ordering matters: **fold after stemming, never before.** The suffix tables
 * are written over accented characters (`ě š č ř ž ý á í é ů`, `ą ć ę ł ń ó ś
 * ź ż`, `á ä č ď é í ĺ ľ ň ó ô ŕ š ť ú ý ž`), so an ASCII-folded term misses
 * the endings the stemmer exists to strip. Diacritic folding, tokenisation,
 * and stopword handling are the caller's concern, applied to the stem this
 * module returns.
 */

import { stemSlovak } from "@/api/lib/legal-search/morphology/slovak";
import { CzechStemmer } from "@/api/lib/legal-search/morphology/snowball/czech.gen";
import { PolishStemmer } from "@/api/lib/legal-search/morphology/snowball/polish.gen";

/** ISO 639-1 codes this module can stem. */
export const MORPHOLOGY_LANGUAGES = ["cs", "pl", "sk"] as const;

export type MorphologyLanguage = (typeof MORPHOLOGY_LANGUAGES)[number];

/**
 * Snowball stemmer instances carry per-call cursor state and are not
 * reentrant, but the API is single-threaded per request and `stem()` resets
 * that state on entry, so one instance per language is safe and avoids
 * allocating a stemmer per term.
 */
const czech = new CzechStemmer();
const polish = new PolishStemmer();

const STEMMERS = {
  cs: (term: string) => czech.stem(term),
  pl: (term: string) => polish.stem(term),
  sk: stemSlovak,
} as const satisfies Record<MorphologyLanguage, (term: string) => string>;

/**
 * Reduce a term to its stem for the given language.
 *
 * Two normalisations happen here, and both are preconditions the underlying
 * stemmers do not enforce themselves:
 *
 * - **NFC.** Every suffix table is written with precomposed code points
 *   (`ě` is U+011B, not `e` + U+030C). A decomposed term keeps its combining
 *   marks through `toLowerCase()`, so `find_among` never matches and the
 *   word passes through unstemmed. Extracted text arrives in whatever form
 *   its producer used, and NFD is common from PDFs and macOS filesystems.
 * - **Lowercase.** The tables are lowercase throughout.
 *
 * Diacritics are deliberately preserved; only the encoding is normalised
 * (see the module note on fold-after-stem ordering).
 */
export const stemLegalTerm = (
  term: string,
  language: MorphologyLanguage,
): string => STEMMERS[language](term.normalize("NFC").toLowerCase());
