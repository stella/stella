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
import { SNOWBALL_RELEASE } from "@/api/lib/legal-search/morphology/snowball/base-stemmer";
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
import { createBoundedMemo } from "@/api/lib/legal-search/morphology/stem-memo";

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
 * What this module stems as, for anything that has to re-do work when the
 * answer changes.
 *
 * Stems are content, not schema: a generation's stem *fields* are pinned by
 * its manifest digest, but what those fields hold depends on the algorithms
 * behind them, so a document stemmed under one release carries stems the next
 * would write differently. The projection folds this into the fingerprint of
 * a generation that writes stem fields, which is what makes a new language or
 * a Snowball upgrade re-project the documents it changes instead of leaving
 * stale stems under a field the read path queries.
 *
 * Derived from the stemmer set rather than declared beside it: adding a
 * language moves the list, and a Snowball upgrade moves the release. The one
 * change it does not see is an edit to the vendored Slovak stemmer, which
 * carries no upstream version of its own.
 */
export const MORPHOLOGY_VERSION = `${SNOWBALL_RELEASE}+${[
  ...MORPHOLOGY_LANGUAGES,
]
  .toSorted()
  .join(",")}`;

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
 * Distinct terms the memo keeps before rotating a generation.
 *
 * Sized against one indexing batch rather than the corpus: a batch of a few
 * hundred documents carries a few hundred thousand tokens over tens of
 * thousands of distinct terms, so a ceiling in this range answers nearly
 * every repeat inside a batch. A larger ceiling would buy hits only across
 * batches, where the term distribution has already moved. Retained entries
 * are at most twice this across both generations, each bounded in size by
 * {@link STEM_MEMO_MAX_KEY_LENGTH}; the two ceilings together are what put a
 * number on the memory.
 */
const STEM_MEMO_MAX_ENTRIES = 50_000;

/**
 * Longest memo key: 64 characters of term, plus the two-character language
 * prefix.
 *
 * Tokenisation splits on anything that is not a letter or a digit but caps no
 * length, and a corpus payload may be tens of millions of characters, so a
 * single malformed document can hand this module a token of arbitrary size.
 * Counting entries would then bound the memo's population but not its bytes,
 * and one such token would stay resident until tens of thousands of ordinary
 * terms displaced it. Past the ceiling a term is still stemmed, just not
 * remembered — it is a term that occurs once, which is precisely the case a
 * memo cannot pay for.
 *
 * 64 clears every word any of these algorithms is written for, German and
 * Finnish compounds included, by a wide margin. A stem never grows past its
 * term (see stem.property.test.ts), so bounding the key bounds the value too.
 */
const STEM_MEMO_MAX_KEY_LENGTH = 66;

/**
 * Stems already computed, across every language.
 *
 * Stemming is the dominant cost of projecting a document into the index, and
 * a legal corpus repeats its terms: inside one decision, and far more across
 * the decisions of one batch. A stem is a pure function of the term and the
 * language, so a remembered answer is the algorithm's answer — the
 * projection's output is unchanged, only the work is.
 *
 * One shared structure rather than one per language, so the memory ceiling is
 * a single number instead of one multiplied by however many languages a
 * deployment touches. Keys are the language code followed by the term; every
 * ISO 639-1 code is two characters, so the prefix is fixed width and no term
 * can spell its way into another language's entry (`stem.test.ts` holds the
 * language list to that width).
 */
const stemMemo = createBoundedMemo({
  maxEntries: STEM_MEMO_MAX_ENTRIES,
  maxKeyLength: STEM_MEMO_MAX_KEY_LENGTH,
});

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
): string =>
  // Keyed by the term as it arrived, not by its normalised form: the memo
  // then answers a repeat without normalising it again, and a key that is
  // already a live string keeps the hash the engine cached for it rather than
  // rehashing a freshly built one on every lookup.
  stemMemo.get(`${language}${term}`, () => {
    const normalized = term.normalize("NFC").toLowerCase();
    const stem = STEMMERS[language].stem(normalized);
    return stem === "" ? normalized : stem;
  });
