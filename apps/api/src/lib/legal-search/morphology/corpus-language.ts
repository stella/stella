import { Result, TaggedError } from "better-result";

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
 * 639-1, whether or not a stemmer exists for them, and the one a reader of
 * that jurisdiction is taken to write in (`primary`, null where there is no
 * one).
 *
 * The one answer to "which stemmers apply to the documents of an index": the
 * projection stems a decision under its own language and blocks, under its
 * own failure kind, a decision whose language its jurisdiction does not
 * declare here ({@link caseLawDocumentStemLanguage}); a query stems the
 * reader's words under every stemmer the searched jurisdictions' documents
 * were stemmed with ({@link caseLawDocumentStemLanguages}). A document in an
 * undeclared language would hold stems no query asks for, so it is not
 * written.
 *
 * Declared generously: a language costs a query at most one stem leaf per
 * word, and a missing one blocks a decision. Slovak courts published in
 * Czech before 1993, so Slovakia declares Czech.
 *
 * Total over the declared jurisdictions, so a new corpus has to answer
 * rather than inherit a default.
 */
const CASE_LAW_DOCUMENT_LANGUAGES = {
  AUT: { primary: "de", languages: ["de"] },
  BRA: { primary: "pt", languages: ["pt"] },
  CZE: { primary: "cs", languages: ["cs"] },
  EU: { primary: null, languages: EU_OFFICIAL_LANGUAGES },
  GBR: { primary: "en", languages: ["en"] },
  HUN: { primary: "hu", languages: ["hu"] },
  POL: { primary: "pl", languages: ["pl"] },
  SVK: { primary: "sk", languages: ["sk", "cs"] },
  USA: { primary: "en", languages: ["en"] },
} as const satisfies Record<
  CaseLawJurisdiction,
  {
    primary: MorphologyLanguage | null;
    languages: readonly [string, ...string[]];
  }
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

/**
 * A case-law document whose language its jurisdiction does not declare, or
 * whose jurisdiction is not declared at all. Its stems would be unreachable,
 * so its projection revision is blocked under its own failure kind rather
 * than written.
 */
export class CaseLawDocumentLanguageUndeclaredError extends TaggedError(
  "CaseLawDocumentLanguageUndeclaredError",
)<{
  jurisdiction: string;
  language: string;
  message: string;
}> {}

/**
 * The stemmer a case-law document is projected under, or null where its
 * language has none; an error where its jurisdiction does not declare its
 * language, because the read side asks each searched jurisdiction's
 * documents in that jurisdiction's declared languages only.
 */
export const caseLawDocumentStemLanguage = ({
  jurisdiction,
  language,
}: {
  jurisdiction: string;
  language: string;
}): Result<
  MorphologyLanguage | null,
  CaseLawDocumentLanguageUndeclaredError
> => {
  const declared = canonicalJurisdiction(jurisdiction);
  if (declared === null) {
    return Result.err(
      new CaseLawDocumentLanguageUndeclaredError({
        jurisdiction,
        language,
        message: `Case-law document of an undeclared jurisdiction: ${jurisdiction}`,
      }),
    );
  }
  const normalized = language.toLowerCase();
  const declaredLanguages: readonly string[] =
    CASE_LAW_DOCUMENT_LANGUAGES[declared].languages;
  if (!declaredLanguages.includes(normalized)) {
    return Result.err(
      new CaseLawDocumentLanguageUndeclaredError({
        jurisdiction: declared,
        language,
        message: `Case-law document of ${declared} in an undeclared language: ${language}`,
      }),
    );
  }
  return Result.ok(documentMorphologyLanguage(normalized));
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
      return declared === null
        ? []
        : CASE_LAW_DOCUMENT_LANGUAGES[declared].languages;
    }),
  );

type DocumentLanguages = typeof CASE_LAW_DOCUMENT_LANGUAGES;

/** The languages a reader of a jurisdiction is taken to write in, as a union. */
type CorpusMorphologyLanguage = Exclude<
  DocumentLanguages[CaseLawJurisdiction]["primary"],
  null
>;

/**
 * The languages readers of the corpus's jurisdictions are taken to write in,
 * deduplicated and sorted.
 *
 * A companion map over these languages (function words, say) then fails to
 * compile when a jurisdiction with a new primary language lands, instead of
 * inheriting whatever the absent entry would have meant.
 */
export const CORPUS_MORPHOLOGY_LANGUAGES: readonly CorpusMorphologyLanguage[] =
  [
    ...new Set(
      CASE_LAW_JURISDICTIONS.flatMap(
        (jurisdiction): CorpusMorphologyLanguage[] => {
          const { primary } = CASE_LAW_DOCUMENT_LANGUAGES[jurisdiction];
          return primary === null ? [] : [primary];
        },
      ),
    ),
  ].toSorted();

/**
 * Which one language a reader of a jurisdiction is taken to write in, or
 * null. An unscoped search spans every jurisdiction of a generation and the
 * European index spans 24 languages, so neither has one.
 *
 * Derived from {@link CASE_LAW_DOCUMENT_LANGUAGES}, so this answer (function
 * words, the passage query's stem field, expansion dictionaries) and the
 * per-document one cannot disagree.
 */
export const corpusMorphologyLanguage = (
  jurisdiction: string | undefined,
): MorphologyLanguage | null => {
  if (jurisdiction === undefined) {
    return null;
  }
  const declared = canonicalJurisdiction(jurisdiction);
  return declared === null
    ? null
    : CASE_LAW_DOCUMENT_LANGUAGES[declared].primary;
};
