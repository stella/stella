import { panic } from "better-result";

import {
  CASE_LAW_JURISDICTIONS,
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";

import {
  MORPHOLOGY_LANGUAGES,
  type MorphologyLanguage,
} from "@/api/lib/legal-search/morphology/stem";

/** The 24 official languages of the European Union, ISO 639-1. */
const EU_OFFICIAL_LANGUAGES = [
  "bg",
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
  "hr",
  "hu",
  "it",
  "lt",
  "lv",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "sv",
] as const;

/**
 * The languages a jurisdiction's case-law documents are written in, ISO
 * 639-1, whether or not a stemmer exists for them.
 *
 * The one answer to "which stemmers apply to the documents of an index": the
 * projection stems a decision under its own language and refuses a language
 * its jurisdiction does not declare here
 * ({@link requireCaseLawDocumentStemLanguage}), and a query stems the
 * reader's words under every stemmer the searched jurisdictions' documents
 * were stemmed with ({@link caseLawDocumentStemLanguages}). A document in an
 * undeclared language would hold stems no query asks for, so it cannot be
 * written.
 *
 * Total over the declared jurisdictions, so a new corpus has to answer
 * rather than inherit a default.
 */
const CASE_LAW_DOCUMENT_LANGUAGES = {
  AUT: ["de"],
  BRA: ["pt"],
  CZE: ["cs"],
  EU: EU_OFFICIAL_LANGUAGES,
  GBR: ["en"],
  HUN: ["hu"],
  POL: ["pl"],
  SVK: ["sk"],
  USA: ["en"],
} as const satisfies Record<
  CaseLawJurisdiction,
  readonly [string, ...string[]]
>;

/**
 * A document's own ISO 639-1 language as a language this module can stem, or
 * null. Stems follow the decision's language rather than its jurisdiction:
 * an index group spans several countries, and the European index holds 24
 * languages.
 */
export const documentMorphologyLanguage = (
  language: string,
): MorphologyLanguage | null =>
  MORPHOLOGY_LANGUAGES.find(
    (candidate) => candidate === language.toLowerCase(),
  ) ?? null;

const canonicalJurisdiction = (
  jurisdiction: string,
): CaseLawJurisdiction | null => {
  const canonical = jurisdiction.toUpperCase();
  return isCaseLawJurisdiction(canonical) ? canonical : null;
};

/** Distinct stemmers of a list of document languages, sorted. */
const stemLanguagesOf = (
  languages: readonly string[],
): readonly MorphologyLanguage[] =>
  [
    ...new Set(
      languages.flatMap((language) => {
        const stem = documentMorphologyLanguage(language);
        return stem === null ? [] : [stem];
      }),
    ),
  ].toSorted();

/**
 * The stemmer a case-law document is projected under, or null where its
 * language has none.
 *
 * Refuses a language its jurisdiction does not declare: the read side asks
 * each searched jurisdiction's documents in that jurisdiction's declared
 * languages only, so such a document's stems would be unreachable. A row
 * like that is an ingestion defect, and failing its projection names it
 * instead of indexing a decision no stemmed query can find.
 */
export const requireCaseLawDocumentStemLanguage = ({
  jurisdiction,
  language,
}: {
  jurisdiction: string;
  language: string;
}): MorphologyLanguage | null => {
  const declared = canonicalJurisdiction(jurisdiction);
  if (declared === null) {
    return panic(
      `Case-law document of an undeclared jurisdiction: ${jurisdiction}`,
    );
  }
  const normalized = language.toLowerCase();
  const declaredLanguages: readonly string[] =
    CASE_LAW_DOCUMENT_LANGUAGES[declared];
  if (!declaredLanguages.includes(normalized)) {
    return panic(
      `Case-law document of ${declared} in an undeclared language: ${language}`,
    );
  }
  return documentMorphologyLanguage(normalized);
};

/**
 * Every stemmer the documents of these jurisdictions were projected under,
 * sorted. A query over them asks the decision field for its words under each,
 * because that field holds each document's stems in the document's own
 * language and nothing else. An undeclared code contributes none.
 */
export const caseLawDocumentStemLanguages = (
  jurisdictions: readonly string[],
): readonly MorphologyLanguage[] =>
  stemLanguagesOf(
    jurisdictions.flatMap((jurisdiction): readonly string[] => {
      const declared = canonicalJurisdiction(jurisdiction);
      return declared === null ? [] : CASE_LAW_DOCUMENT_LANGUAGES[declared];
    }),
  );

type DocumentLanguages = typeof CASE_LAW_DOCUMENT_LANGUAGES;

/** The stemmer of a jurisdiction written in exactly one stemmable language. */
type SingleStemLanguage<J extends CaseLawJurisdiction> =
  DocumentLanguages[J] extends readonly [infer Only]
    ? Extract<Only, MorphologyLanguage>
    : never;

/** The languages of the corpus's single-language jurisdictions, as a union. */
export type CorpusMorphologyLanguage = {
  [J in CaseLawJurisdiction]: SingleStemLanguage<J>;
}[CaseLawJurisdiction];

/** Whether some jurisdiction is written in this language alone. */
const isCorpusMorphologyLanguage = (
  language: MorphologyLanguage,
): language is CorpusMorphologyLanguage =>
  CASE_LAW_JURISDICTIONS.some((jurisdiction) => {
    const languages: readonly string[] =
      CASE_LAW_DOCUMENT_LANGUAGES[jurisdiction];
    return languages.length === 1 && languages[0] === language;
  });

/**
 * The one language a jurisdiction's text is written in, when its documents
 * are written in one language and a stemmer for it exists, or null.
 *
 * Derived from {@link CASE_LAW_DOCUMENT_LANGUAGES}, so the single-language
 * answer (function words, the passage query's stem field, expansion
 * dictionaries) and the per-document answer cannot disagree. The European
 * index has no one language and answers null.
 */
const singleDocumentLanguage = (
  jurisdiction: CaseLawJurisdiction,
): CorpusMorphologyLanguage | null => {
  const languages: readonly string[] =
    CASE_LAW_DOCUMENT_LANGUAGES[jurisdiction];
  const [only] = languages;
  if (languages.length !== 1 || only === undefined) {
    return null;
  }
  const language = documentMorphologyLanguage(only);
  return language !== null && isCorpusMorphologyLanguage(language)
    ? language
    : null;
};

/**
 * The languages the corpus's single-language jurisdictions are written in,
 * deduplicated and sorted.
 *
 * A companion map over these languages (function words, say) then fails to
 * compile when a new single-language jurisdiction lands, instead of
 * inheriting whatever the absent entry would have meant.
 */
export const CORPUS_MORPHOLOGY_LANGUAGES: readonly CorpusMorphologyLanguage[] =
  [
    ...new Set(
      CASE_LAW_JURISDICTIONS.flatMap(
        (jurisdiction): CorpusMorphologyLanguage[] => {
          const language = singleDocumentLanguage(jurisdiction);
          return language === null ? [] : [language];
        },
      ),
    ),
  ].toSorted();

/**
 * Which one language a jurisdiction's text stems against, or null. An
 * unscoped search spans every jurisdiction of a generation and the European
 * index spans 24 languages, so neither has one.
 */
export const corpusMorphologyLanguage = (
  jurisdiction: string | undefined,
): MorphologyLanguage | null => {
  if (jurisdiction === undefined) {
    return null;
  }
  const declared = canonicalJurisdiction(jurisdiction);
  return declared === null ? null : singleDocumentLanguage(declared);
};
