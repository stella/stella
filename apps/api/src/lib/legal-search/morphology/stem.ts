/**
 * Morphological stemming for legal-corpus terms.
 *
 * Every language here but Slovak runs the official Snowball algorithm,
 * generated from the pinned v3.1.1 release (see `./snowball/`): German and
 * the EU official languages that release ships an algorithm for. Snowball has
 * none for Bulgarian, Croatian, Latvian, Maltese, Slovenian or Slovak;
 * Slovak runs Wikimedia's light stemmer instead (see `./slovak`), of the same
 * Dolamic and Savoy light-stemming family as its Czech and Polish
 * neighbours, so its aggressiveness is comparable. Text in a language absent
 * from this list is not stemmed at all.
 *
 * Ordering matters: **fold after stemming, never before.** The suffix tables
 * are written over accented characters (`ě š č ř ž ý á í é ů`, `ą ć ę ł ń ó ś
 * ź ż`, `ä ö ü`, `à â ç é è ê î ô û`, `ά έ ή ί ό ύ ώ`, and so on), so an
 * ASCII-folded term misses the endings the stemmer exists to strip.
 * Diacritic folding, tokenisation, and stopword handling are the caller's
 * concern, applied to the stem this module returns.
 */

import { stemSlovak } from "@/api/lib/legal-search/morphology/slovak";
import { CzechStemmer } from "@/api/lib/legal-search/morphology/snowball/czech.gen";
import { DanishStemmer } from "@/api/lib/legal-search/morphology/snowball/danish.gen";
import { DutchStemmer } from "@/api/lib/legal-search/morphology/snowball/dutch.gen";
import { EnglishStemmer } from "@/api/lib/legal-search/morphology/snowball/english.gen";
import { EstonianStemmer } from "@/api/lib/legal-search/morphology/snowball/estonian.gen";
import { FinnishStemmer } from "@/api/lib/legal-search/morphology/snowball/finnish.gen";
import { FrenchStemmer } from "@/api/lib/legal-search/morphology/snowball/french.gen";
import { GermanStemmer } from "@/api/lib/legal-search/morphology/snowball/german.gen";
import { GreekStemmer } from "@/api/lib/legal-search/morphology/snowball/greek.gen";
import { HungarianStemmer } from "@/api/lib/legal-search/morphology/snowball/hungarian.gen";
import { IrishStemmer } from "@/api/lib/legal-search/morphology/snowball/irish.gen";
import { ItalianStemmer } from "@/api/lib/legal-search/morphology/snowball/italian.gen";
import { LithuanianStemmer } from "@/api/lib/legal-search/morphology/snowball/lithuanian.gen";
import { PolishStemmer } from "@/api/lib/legal-search/morphology/snowball/polish.gen";
import { PortugueseStemmer } from "@/api/lib/legal-search/morphology/snowball/portuguese.gen";
import { RomanianStemmer } from "@/api/lib/legal-search/morphology/snowball/romanian.gen";
import { SpanishStemmer } from "@/api/lib/legal-search/morphology/snowball/spanish.gen";
import { SwedishStemmer } from "@/api/lib/legal-search/morphology/snowball/swedish.gen";

/** ISO 639-1 codes this module can stem. */
export const MORPHOLOGY_LANGUAGES = [
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "ga",
  "hu",
  "it",
  "lt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "sv",
] as const;

export type MorphologyLanguage = (typeof MORPHOLOGY_LANGUAGES)[number];

/**
 * Snowball stemmer instances carry per-call cursor state and are not
 * reentrant, but the API is single-threaded per request and `stem()` resets
 * that state on entry, so one instance per language is safe and avoids
 * allocating a stemmer per term.
 */
const STEMMERS = {
  cs: new CzechStemmer(),
  da: new DanishStemmer(),
  de: new GermanStemmer(),
  el: new GreekStemmer(),
  en: new EnglishStemmer(),
  es: new SpanishStemmer(),
  et: new EstonianStemmer(),
  fi: new FinnishStemmer(),
  fr: new FrenchStemmer(),
  ga: new IrishStemmer(),
  hu: new HungarianStemmer(),
  it: new ItalianStemmer(),
  lt: new LithuanianStemmer(),
  nl: new DutchStemmer(),
  pl: new PolishStemmer(),
  pt: new PortugueseStemmer(),
  ro: new RomanianStemmer(),
  sk: { stem: stemSlovak },
  sv: new SwedishStemmer(),
} as const satisfies Record<
  MorphologyLanguage,
  { stem: (term: string) => string }
>;

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
 *
 * A non-empty term always yields a non-empty stem. The Estonian, Finnish and
 * Lithuanian algorithms strip a term made only of characters they treat as
 * ignorable, and an empty stem would drop a token out of the stem stream and
 * shift every position after it, so the normalised term stands in for one.
 */
export const stemLegalTerm = (
  term: string,
  language: MorphologyLanguage,
): string => {
  const normalized = term.normalize("NFC").toLowerCase();
  const stem = STEMMERS[language].stem(normalized);
  return stem === "" ? normalized : stem;
};
